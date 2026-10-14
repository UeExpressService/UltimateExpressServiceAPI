(function initializeRouteMapHelper() {
    const addressCache = new Map();
    let lastGeocodeAt = 0;
    let geocodeQueue = Promise.resolve();

    function setStatus(statusElement, message) {
        if (statusElement) statusElement.textContent = message;
    }

    function createRouteMap(elementId, statusElement) {
        const element = document.getElementById(elementId);
        if (!element) {
            setStatus(statusElement, 'The route map container is unavailable.');
            return null;
        }
        if (!window.L) {
            setStatus(statusElement, 'The map library did not load. Check your internet connection and reload.');
            return null;
        }

        try {
            const map = window.L.map(element, { zoomControl: true }).setView([14.5995, 120.9842], 6);
            window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(map);
            map._ueRouteLayer = window.L.layerGroup().addTo(map);
            map._ueMarkerLayer = window.L.layerGroup().addTo(map);
            map._ueStatusElement = statusElement;
            map.on('tileerror', () => setStatus(statusElement, 'Map tiles could not load. The route summary and directions link are still available.'));
            return map;
        } catch (error) {
            console.error('Unable to initialize route map:', error);
            setStatus(statusElement, 'Unable to initialize the route map. You can still open the directions link.');
            return null;
        }
    }

    function invalidateMapSize(map) {
        if (!map) return;
        requestAnimationFrame(() => map.invalidateSize({ pan: false }));
        setTimeout(() => map.invalidateSize({ pan: false }), 150);
    }

    function geocodeAddress(address) {
        const normalizedAddress = String(address || '').trim();
        const cacheKey = normalizedAddress.toLowerCase();
        if (!cacheKey) return null;
        const lookup = geocodeQueue.then(async () => {
            if (addressCache.has(cacheKey)) return addressCache.get(cacheKey);
            const waitTime = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
            if (waitTime) await new Promise(resolve => setTimeout(resolve, waitTime));
            const url = new URL('https://nominatim.openstreetmap.org/search');
            url.search = new URLSearchParams({
                q: normalizedAddress,
                format: 'jsonv2',
                limit: '1',
                countrycodes: 'ph'
            });
            lastGeocodeAt = Date.now();
            const response = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`Address lookup failed (${response.status}).`);
            const results = await response.json();
            if (!Array.isArray(results) || results.length === 0) return null;
            const location = {
                lat: Number(results[0].lat),
                lng: Number(results[0].lon),
                label: String(results[0].display_name || normalizedAddress)
            };
            if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
                throw new Error('Address lookup returned invalid coordinates.');
            }
            addressCache.set(cacheKey, location);
            return location;
        });
        geocodeQueue = lookup.catch(() => {});
        return lookup;
    }

    function addMarker(map, position, title, label) {
        const popup = document.createElement('div');
        const heading = document.createElement('strong');
        heading.textContent = title;
        const address = document.createElement('div');
        address.textContent = label;
        popup.append(heading, address);
        window.L.marker(position).addTo(map._ueMarkerLayer).bindPopup(popup);
    }

    async function drawAddressRoute(map, pickupAddress, deliveryAddress, statusElement) {
        if (!map) return false;
        const requestId = (map._ueRouteRequestId || 0) + 1;
        map._ueRouteRequestId = requestId;
        map._ueRouteLayer.clearLayers();
        map._ueMarkerLayer.clearLayers();
        invalidateMapSize(map);

        const pickupText = String(pickupAddress || '').trim();
        const deliveryText = String(deliveryAddress || '').trim();
        if (!pickupText || !deliveryText) {
            setStatus(statusElement, 'Pickup and delivery addresses are needed to draw this route.');
            return false;
        }

        setStatus(statusElement, 'Finding both addresses and calculating the road route...');
        try {
            const pickup = await geocodeAddress(pickupText);
            if (map._ueRouteRequestId !== requestId) return false;
            const delivery = await geocodeAddress(deliveryText);
            if (map._ueRouteRequestId !== requestId) return false;
            if (!pickup || !delivery) {
                throw new Error('We could not locate one or both addresses. Check the address details.');
            }

            const pickupPoint = [pickup.lat, pickup.lng];
            const deliveryPoint = [delivery.lat, delivery.lng];
            addMarker(map, pickupPoint, 'Pickup', pickup.label);
            addMarker(map, deliveryPoint, 'Delivery', delivery.label);
            const bounds = window.L.latLngBounds([pickupPoint, deliveryPoint]);

            let routePoints = [];
            let distanceMeters = null;
            try {
                const routeUrl = new URL(
                    `https://router.project-osrm.org/route/v1/driving/${pickup.lng},${pickup.lat};${delivery.lng},${delivery.lat}`
                );
                routeUrl.search = new URLSearchParams({ overview: 'full', geometries: 'geojson' });
                const routeResponse = await fetch(routeUrl);
                if (map._ueRouteRequestId !== requestId) return false;
                if (!routeResponse.ok) throw new Error(`Route lookup failed (${routeResponse.status}).`);
                const routeData = await routeResponse.json();
                if (map._ueRouteRequestId !== requestId) return false;
                const route = routeData.code === 'Ok' ? routeData.routes?.[0] : null;
                if (!route) throw new Error('No drivable route was found between these addresses.');
                routePoints = (route.geometry?.coordinates || [])
                    .filter(point => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
                    .map(([lng, lat]) => [Number(lat), Number(lng)]);
                distanceMeters = Number.isFinite(Number(route.distance)) ? Number(route.distance) : null;
                if (routePoints.length < 2) throw new Error('The route service returned no road geometry.');
                window.L.polyline(routePoints, { color: '#e07b39', weight: 5, opacity: 0.85 }).addTo(map._ueRouteLayer);
                setStatus(statusElement, `Road route${distanceMeters ? ` · ${(distanceMeters / 1000).toFixed(1)} km` : ''}. Estimated map route; not live vehicle tracking.`);
            } catch (routeError) {
                console.warn('Road route unavailable; displaying a straight-line estimate:', routeError);
                window.L.polyline([pickupPoint, deliveryPoint], {
                    color: '#e07b39',
                    weight: 4,
                    opacity: 0.85,
                    dashArray: '8 8'
                }).addTo(map._ueRouteLayer);
                setStatus(statusElement, 'Road route service is unavailable. Dashed line shows a straight-line estimate, not the road route or live tracking.');
            }

            if (map._ueRouteRequestId !== requestId) return false;
            map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
            invalidateMapSize(map);
            return true;
        } catch (error) {
            if (map._ueRouteRequestId === requestId) {
                console.error('Address route map failed:', error);
                setStatus(statusElement, error.message || 'Unable to display the route. Please try again.');
            }
            return false;
        }
    }

    window.UE = window.UE || {};
    window.UE.RouteMap = { create: createRouteMap, draw: drawAddressRoute, invalidate: invalidateMapSize };
})();
