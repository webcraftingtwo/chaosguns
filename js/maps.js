/* ============================================================
   maps.js — tactical schematics for the theater map interface.
   ------------------------------------------------------------
   These are ORIGINAL stylised schematics drawn for this terminal,
   not the game's map art: an in-world intel diagram, the way a
   dossier would render a site. Zone names and geometry live here
   (not in the database) so you can rename a zone, nudge a polygon,
   or add a whole new theater without a migration — the drop's
   zone_tag is just the zone name string.

   To add a theater: add a key matching one of intelDB.MAPS, give
   it a viewBox, decor (non-interactive background detail) and zones
   (clickable polygons). Coordinates are in viewBox units.
   ============================================================ */

'use strict';

const MAP_SCHEMATICS = {
  'ZERO DAM': {
    viewBox: '0 0 1000 660',
    caption: 'ZERO DAM — HYDROELECTRIC COMPLEX // SCHEMATIC 7C-04',
    scale: 'APPROX. 1.4 KM ACROSS // ORIENTATION: NORTH UP',

    /* background detail: water, contours, structures, channel */
    decor: `
      <defs>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse"
                 patternTransform="rotate(35)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor"
                stroke-width="0.6" opacity="0.35"/>
        </pattern>
        <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
          <path d="M50 0 L0 0 0 50" fill="none" stroke="currentColor"
                stroke-width="0.4" opacity="0.13"/>
        </pattern>
      </defs>

      <rect x="0" y="0" width="1000" height="660" fill="url(#grid)"/>

      <!-- reservoir water -->
      <polygon points="70,60 430,52 470,150 400,250 190,290 80,210"
               fill="url(#hatch)" opacity="0.5"/>
      <path d="M120,120 Q220,100 320,120" fill="none" stroke="currentColor"
            stroke-width="0.8" opacity="0.3"/>
      <path d="M110,170 Q230,150 340,175" fill="none" stroke="currentColor"
            stroke-width="0.8" opacity="0.3"/>
      <path d="M150,225 Q250,205 360,222" fill="none" stroke="currentColor"
            stroke-width="0.8" opacity="0.25"/>

      <!-- ridge contours -->
      <path d="M712,340 Q830,300 950,300" fill="none" stroke="currentColor"
            stroke-width="0.7" opacity="0.28"/>
      <path d="M722,392 Q840,352 956,352" fill="none" stroke="currentColor"
            stroke-width="0.7" opacity="0.24"/>
      <path d="M734,444 Q848,404 960,404" fill="none" stroke="currentColor"
            stroke-width="0.7" opacity="0.2"/>

      <!-- turbine structures -->
      <rect x="668" y="150" width="52" height="34" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.45"/>
      <rect x="732" y="140" width="52" height="34" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.45"/>
      <rect x="796" y="132" width="40" height="34" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.45"/>

      <!-- village blocks -->
      <rect x="130" y="345" width="34" height="26" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <rect x="182" y="338" width="30" height="26" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <rect x="150" y="392" width="40" height="24" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <rect x="232" y="352" width="36" height="30" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.4"/>

      <!-- cargo containers -->
      <rect x="592" y="530" width="46" height="18" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.42"/>
      <rect x="650" y="540" width="46" height="18" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.42"/>
      <rect x="606" y="566" width="46" height="18" fill="none"
            stroke="currentColor" stroke-width="1" opacity="0.42"/>

      <!-- water discharge arrows through the spillway -->
      <path d="M508,352 L520,398 M520,398 L512,390 M520,398 L528,388"
            fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.5"/>
      <path d="M300,486 L360,470 M360,470 L350,466 M360,470 L352,478"
            fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.4"/>
    `,

    /* clickable zones — name is what gets stored as the drop's zone_tag */
    zones: [
      { name: 'RESERVOIR',    points: '70,60 430,52 470,150 400,250 190,290 80,210',  label: [240, 165] },
      { name: 'DAM WALL',     points: '430,52 522,44 612,300 528,318 470,150',        label: [512, 190] },
      { name: 'SPILLWAY',     points: '470,330 612,312 664,430 520,470 432,410',      label: [540, 392] },
      { name: 'TURBINE HALL', points: '634,116 836,96 876,252 690,288',               label: [756, 200] },
      { name: 'RADIO MAST',   points: '862,58 962,70 944,192 872,180',                label: [912, 130] },
      { name: 'EAST RIDGE',   points: '700,320 952,272 972,520 782,542',              label: [842, 424] },
      { name: 'OLD VILLAGE',  points: '90,320 332,300 382,420 250,472 110,442',       label: [228, 392] },
      { name: 'RIVERBED',     points: '178,494 424,436 540,500 480,612 222,604',      label: [346, 534] },
      { name: 'CARGO YARD',   points: '560,500 762,540 742,624 572,620',              label: [654, 574] },
    ],

    /* extraction markers — flavour, not clickable */
    extracts: [
      { name: 'EXTRACT — WEST SHORE', at: [96, 494] },
      { name: 'EXTRACT — SOUTH GATE', at: [896, 596] },
    ],
  },
};
