# Website styles

Edit `style.css` for all first-party website styling. Its numbered contents and section headings cover shared authentication forms, waybills, each page, presentation helpers, and UE dialogs.

Each HTML page loads this stylesheet and declares `data-page` on its root element. Keep page layout rules scoped with `:where(html[data-page="..."])` so changes cannot affect another page. Name animations with the `ue-<page>-` prefix.

CSS image paths are relative to this directory (`../images/...`). Keep responsive and print rules with their page section. JavaScript may update runtime visibility, progress, and transforms; put fixed presentation in this stylesheet.

Fonts, Bootstrap Icons, and Leaflet remain vendor stylesheets. The old `auth.css` and `waybills.css` files only forward to `styles/style.css` for URL compatibility and contain no style definitions.
