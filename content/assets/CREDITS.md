# Bilig 3D asset credits

Every binary asset in `content/assets/<topicKey>/` is listed here and in that
folder's `ASSET.json` (licence, author, source URL, download date,
modifications; TZ A-05). `content/build.mjs` refuses to hash an asset that has
no `ASSET.json` entry with a licence, an author and a source. Only clearly
free licences are accepted: CC0, public domain / US government works, and
CC BY (with the attribution below). No NC, ND, "editorial only" or
login-gated sources.

## human-heart

Files: `human-heart.glb`, `thumbs/human-heart.webp`, `thumbs/heart-section.webp`

> Heart and great vessels: "3D Reference Organ for Heart, Male v1.3"
> (<https://doi.org/10.48539/HBM564.WKNG.249>) and "3D Reference Organ for
> Blood Vasculature, Male v1.3" by Kristen Browne and Heidi Schlehlein,
> Human Reference Atlas / NIH HuBMAP (<https://humanatlas.io/3d-reference-library>),
> made from the Visible Human Male (National Library of Medicine). Licensed
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Modified by
> Bilig: subset of vessels, renamed parts, simplified, recoloured, schematic
> pericardium added.

- Downloaded 2026-10-15 from
  `https://cdn.humanatlas.io/digital-objects/ref-organ/heart-male/v1.3/assets/3d-vh-m-heart.glb`
  and
  `https://cdn.humanatlas.io/digital-objects/ref-organ/blood-vasculature-male/v1.3/assets/3d-vh-m-blood-vasculature.glb`.
- Pipeline: `scripts/assets/human-heart.mjs`.

## earth-layers

Files: `earth-layers.glb`, `thumbs/earth-layers.webp`

> Earth texture: NASA Earth Observatory, Blue Marble Next Generation
> (Reto Stöckli, NASA GSFC), December 2004, topography and bathymetry.
> Public domain (NASA imagery is not copyrighted).

- Layer geometry, plate patches and earthquake markers: made by Bilig,
  released under CC0 1.0. Radii are to scale except the crust, which is
  exaggerated so that it is visible. Plates and epicentres are schematic.
- Downloaded 2026-10-15 from
  `https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg`.
- Pipeline: `scripts/assets/earth-layers.mjs`.
