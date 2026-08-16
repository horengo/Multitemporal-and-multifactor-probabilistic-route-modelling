/*
  Multi-temporal, Multi-factor, Probabilistic Route Modelling (M2PRM)
  Google Earth Engine JavaScript (Code Editor)
 
 
  QUICK START
  1. Run this script in the Earth Engine Code Editor (copy and past the text
     there).
  2. Edit the red analysis polygon, or erase it and draw a new polygon or
     rectangle with the map drawing tools.
  3. Select a period. For every factor, "Use" controls whether it contributes
     to the final surface and "Show" controls its initial map visibility.
  4. Press "CALCULATE COST SURFACE".
  5. To export the calculated cost-surface, open Export, choose a resolution,
     and press "CREATE DRIVE EXPORT TASK". Then start the task from the Tasks tab.
  6. To create a cost profile, open Cost profiles after calculation, draw a
     line, choose the profile contents and sampling settings, and generate the
     graph. The sampled table can also be exported as CSV.
 
  IMPORTANT
  - The GRanD reservoir and loose-sand layers are user assets. Users must obtain
    their own version if the GRanD database, here is only provided for reproducibility.
  - Drive exports create tasks, they do not start automatically. See point 6 above.
 */


// -----------------------------------------------------------------------------
// 1. ESTABLISHED DEFAULTS
// -----------------------------------------------------------------------------

var DEFAULT_CENTER = {lon: 67.601, lat: 37.566, zoom: 4};

var DEFAULT_GEOMETRY = ee.Geometry.Polygon([
  [26.034856936314327, 31.965400777310872],
  [34.19255939893447, 27.520378920323584],
  [70.85299048338345, 19.854238685800006],
  [90.28374707240327, 20.074324423110866],
  [112.29527848792249, 21.22664649657822],
  [112.23560562718355, 47.3578548447329],
  [70.6364691148242, 53.122300330081565],
  [25.974978246994738, 47.85290888472198],
  [26.034856936314327, 31.965400777310872]
]);

// Fixed validity limits of the standard wind-chill equation.
var WIND_CHILL_MAX_TEMPERATURE_C = 10;
var WIND_CHILL_MIN_SPEED_KMH = 4.8;

var DEFAULTS = {
  periodLabel: 'January',
  maxCost: 40,
  outputType: 'Float',
  showFinal: true,
  printSettings: true,

  slopeCap: 99.99,
  snowDivisor: 50,
  seaOccurrence: 90,

  damAsset: 'users/hao23/Grand_reservoirs',
  damProperty: 'value',
  damReplacement: 3.28,

  coldMinimum: -13,
  coldMaximum: 0,
  coldMultiplier: 1.5,

  sandAsset: 'users/hao23/looseSand_SA',
  sandThreshold: 0.7,
  sandCoefficient: 0.35,

  heatMinimum: 26,
  heatMaximum: 38,
  heatExponent: 2,
  desertEvi: 0.075,
  noWaterMaximum: 1.5,
  eviAnnualStart: '1984-01-01',
  eviAnnualEnd: '1995-12-31',
  eviMonthlyStart: '1984-01-01',
  eviMonthlyEnd: '2015-12-31',

  attractionRadius: 15,
  attractionEvi: 0.2,
  attractionMultiplier: 0.75,

  surfaceWaterDivisor: 33.33,
  heightThreshold: 2000,

  floatDecimals: 4,
  floatMultiplier: 0.0001,
  floatFill: 0.004,

  exportPrefix: 'costsurf_',
  exportFolder: ''
};

var PERIODS = {
  'Whole year': {key: 'yr', name: 'yr', startDay: 1, endDay: 364},
  'January': {key: 'jan', name: 'jan', startDay: 1, endDay: 31, monthNum: '00', altNum: '01'},
  'February': {key: 'feb', name: 'feb', startDay: 32, endDay: 59, monthNum: '01', altNum: '02'},
  'March': {key: 'mar', name: 'mar', startDay: 60, endDay: 90, monthNum: '02', altNum: '03'},
  'April': {key: 'apr', name: 'apr', startDay: 91, endDay: 120, monthNum: '03', altNum: '04'},
  'May': {key: 'may', name: 'may', startDay: 121, endDay: 151, monthNum: '04', altNum: '05'},
  'June': {key: 'jun', name: 'jun', startDay: 152, endDay: 181, monthNum: '05', altNum: '06'},
  'July': {key: 'jul', name: 'jul', startDay: 182, endDay: 212, monthNum: '06', altNum: '07'},
  'August': {key: 'aug', name: 'aug', startDay: 213, endDay: 243, monthNum: '07', altNum: '08'},
  'September': {key: 'sep', name: 'sep', startDay: 244, endDay: 273, monthNum: '08', altNum: '09'},
  'October': {key: 'oct', name: 'oct', startDay: 274, endDay: 304, monthNum: '09', altNum: '10'},
  'November': {key: 'nov', name: 'nov', startDay: 305, endDay: 334, monthNum: '10', altNum: '11'},
  'December': {key: 'dec', name: 'dec', startDay: 335, endDay: 365, monthNum: '11', altNum: '12'}
};

var FACTOR_DEFAULTS = {
  slope: {use: true, show: false},
  noWater: {use: true, show: false},
  waterAttraction: {use: false, show: false},
  surfaceWater: {use: true, show: false},
  snow: {use: true, show: false},
  looseSand: {use: true, show: false},
  cold: {use: true, show: false},
  height: {use: true, show: false},
  reservoirs: {use: true, show: false},
  sea: {use: true, show: false}
};

var COST_PALETTE = ['0f00ff', '03ff00', 'efff00', 'ffbc00', 'ff0000', 'ff0081'];
var MULTIPLIER_PALETTE = ['313695', '74add1', 'ffffbf', 'f46d43', 'a50026'];


// -----------------------------------------------------------------------------
// 2. APPLICATION STATE AND GENERAL UI HELPERS
// -----------------------------------------------------------------------------

var appState = {
  nativeScale: null,
  result: null,
  runId: 0
};

// State used only by the profile interface. It is deliberately separate from
// the model state so profile drawing and sampling cannot alter the calculation.
var profileState = {
  lineLayer: null,
  samples: null,
  bandNames: null,
  selectors: null,
  sourceLabel: null,
  requestedPoints: null,
  periodName: null,
  sourceTag: null,
  samplingScale: null,
  runId: 0
};

var controls = {};
var factorControls = {};
var resetRegistry = [];

function remember(widget, defaultValue) {
  resetRegistry.push({widget: widget, value: defaultValue});
  return widget;
}

function makeLabel(value, style) {
  return ui.Label({value: value, style: style || {}});
}

function helpLabel(value) {
  return makeLabel(value, {
    color: '#52606d',
    fontSize: '11px',
    whiteSpace: 'pre-wrap',
    margin: '2px 4px 6px 4px'
  });
}

function parameterRow(panel, key, label, defaultValue, help) {
  var box = remember(ui.Textbox({
    value: String(defaultValue),
    style: {stretch: 'horizontal', margin: '1px 0 1px 4px'}
  }), String(defaultValue));
  controls[key] = box;
  panel.add(ui.Panel({
    widgets: [
      makeLabel(label, {width: '230px', margin: '5px 0 0 4px'}),
      box
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {stretch: 'horizontal'}
  }));
  if (help) panel.add(helpLabel(help));
  return box;
}

function wideTextRow(panel, key, label, defaultValue, help) {
  panel.add(makeLabel(label, {fontWeight: 'bold', margin: '5px 4px 1px 4px'}));
  var box = remember(ui.Textbox({
    value: String(defaultValue),
    style: {stretch: 'horizontal', margin: '1px 4px'}
  }), String(defaultValue));
  controls[key] = box;
  panel.add(box);
  if (help) panel.add(helpLabel(help));
  return box;
}

function selectRow(panel, key, label, items, defaultValue, help) {
  var select = remember(ui.Select({
    items: items,
    value: defaultValue,
    style: {stretch: 'horizontal', margin: '1px 0 1px 4px'}
  }), defaultValue);
  controls[key] = select;
  panel.add(ui.Panel({
    widgets: [
      makeLabel(label, {width: '230px', margin: '5px 0 0 4px'}),
      select
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {stretch: 'horizontal'}
  }));
  if (help) panel.add(helpLabel(help));
  return select;
}

function checkboxRow(panel, key, label, defaultValue, help) {
  var checkbox = remember(ui.Checkbox({
    label: label,
    value: defaultValue,
    style: {margin: '3px 4px'}
  }), defaultValue);
  controls[key] = checkbox;
  panel.add(checkbox);
  if (help) panel.add(helpLabel(help));
  return checkbox;
}

function makeSection(parent, title, description, initiallyOpen) {
  var open = initiallyOpen;
  var body = ui.Panel({
    style: {
      shown: initiallyOpen,
      padding: '5px 6px 7px 6px',
      backgroundColor: '#ffffff'
    }
  });
  if (description) body.add(helpLabel(description));

  var toggle = ui.Button({
    label: (open ? '▼ ' : '▶ ') + title,
    style: {
      stretch: 'horizontal',
      textAlign: 'left',
      fontWeight: 'bold',
      backgroundColor: '#dfe7ef',
      margin: '0'
    }
  });
  toggle.onClick(function() {
    open = !open;
    body.style().set('shown', open);
    toggle.setLabel((open ? '▼ ' : '▶ ') + title);
  });

  parent.add(ui.Panel({
    widgets: [toggle, body],
    style: {border: '1px solid #cbd5e1', margin: '5px 0 0 0'}
  }));
  return body;
}

function makeFactorCard(parent, key, title, description, initiallyOpen) {
  var defaults = FACTOR_DEFAULTS[key];
  var open = initiallyOpen;
  var body = ui.Panel({
    style: {
      shown: initiallyOpen,
      padding: '4px 6px 7px 10px',
      backgroundColor: '#fbfdff'
    }
  });
  body.add(helpLabel(description));

  var useBox = remember(ui.Checkbox({
    label: 'Use',
    value: defaults.use,
    style: {width: '58px', margin: '3px 0'}
  }), defaults.use);
  var showBox = remember(ui.Checkbox({
    label: 'Show',
    value: defaults.show,
    style: {width: '68px', margin: '3px 0'}
  }), defaults.show);
  factorControls[key] = {use: useBox, show: showBox};

  var toggle = ui.Button({
    label: (open ? '▼ ' : '▶ ') + title,
    style: {
      width: '245px',
      textAlign: 'left',
      backgroundColor: '#eef3f8',
      margin: '0'
    }
  });
  toggle.onClick(function() {
    open = !open;
    body.style().set('shown', open);
    toggle.setLabel((open ? '▼ ' : '▶ ') + title);
  });

  var header = ui.Panel({
    widgets: [toggle, useBox, showBox],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {stretch: 'horizontal', backgroundColor: '#eef3f8'}
  });
  parent.add(ui.Panel({
    widgets: [header, body],
    style: {border: '1px solid #d8e1ea', margin: '4px 0'}
  }));
  return body;
}

function setStatus(message, kind) {
  var colors = {
    ready: '#334e68',
    working: '#8a4b08',
    success: '#176b3a',
    error: '#b42318'
  };
  statusLabel.setValue(message);
  statusLabel.style().set('color', colors[kind] || colors.ready);
}

function readNumber(key, label, minimum, maximum, integerRequired) {
  var raw = controls[key].getValue();
  var value = Number(raw);
  if (raw === null || String(raw).trim() === '' || !isFinite(value)) {
    throw new Error(label + ' must be a valid number.');
  }
  if (minimum !== null && minimum !== undefined && value < minimum) {
    throw new Error(label + ' must be at least ' + minimum + '.');
  }
  if (maximum !== null && maximum !== undefined && value > maximum) {
    throw new Error(label + ' must not exceed ' + maximum + '.');
  }
  if (integerRequired && Math.round(value) !== value) {
    throw new Error(label + ' must be a whole number.');
  }
  return value;
}

function readText(key, label, required) {
  var value = String(controls[key].getValue() || '').trim();
  if (required && value === '') throw new Error(label + ' cannot be empty.');
  return value;
}

function readDate(key, label) {
  var value = readText(key, label, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(label + ' must use YYYY-MM-DD.');
  }
  var parsed = new Date(value + 'T00:00:00Z');
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(label + ' is not a valid calendar date.');
  }
  return value;
}

function factorIsNeeded(settings, key) {
  return settings.factors[key].use || settings.factors[key].show;
}


// -----------------------------------------------------------------------------
// 3. EDITABLE ANALYSIS AREA
// -----------------------------------------------------------------------------

// Use an explicit ui.Map instance. This guarantees that ui.SplitPanel receives
// a genuine ui.Map even in Code Editor sessions where the built-in Map object
// has been replaced, shadowed, or retained in another root layout.
var appMap = ui.Map();
appMap.setCenter(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, DEFAULT_CENTER.zoom);

var drawingTools = appMap.drawingTools();
drawingTools.setLinked(false);
drawingTools.setShown(true);
drawingTools.setDrawModes(['polygon', 'rectangle']);

function createProfileLineLayer() {
  profileState.lineLayer = drawingTools.addLayer(
    [], 'Profile line', '#d73027', true, false
  );
  drawingTools.setSelected(null);
}

function ensureProfileLineLayer() {
  var layers = drawingTools.layers();
  var attached = false;
  var i;
  for (i = 0; i < layers.length(); i++) {
    if (layers.get(i) === profileState.lineLayer) attached = true;
  }
  if (!attached) createProfileLineLayer();
}

function resetAnalysisArea() {
  drawingTools.layers().reset([]);
  drawingTools.addLayer([DEFAULT_GEOMETRY], 'Analysis area', '#f46d43', true, false);
  appMap.setCenter(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, DEFAULT_CENTER.zoom);
  appState.result = null;
}

function getAnalysisArea() {
  var layers = drawingTools.layers();
  var features = [];
  var i;
  for (i = 0; i < layers.length(); i++) {
    var layer = layers.get(i);
    // The profile line is a sampling geometry, never part of the analysis AOI.
    if (layer === profileState.lineLayer) continue;
    if (layer.geometries().length() > 0) {
      features.push(ee.Feature(layer.toGeometry()));
    }
  }
  if (features.length === 0) {
    throw new Error('No analysis area exists. Draw at least one polygon or rectangle.');
  }
  return ee.FeatureCollection(features).geometry();
}

resetAnalysisArea();
createProfileLineLayer();


// -----------------------------------------------------------------------------
// 4. CONTROL PANEL
// -----------------------------------------------------------------------------

var sidebar = ui.Panel({
  style: {
    width: '445px',
    minWidth: '400px',
    maxWidth: '500px',
    padding: '10px',
    backgroundColor: '#f7f9fb'
  }
});

sidebar.add(makeLabel('M2PRM COST-SURFACE BUILDER', {
  fontSize: '22px',
  fontWeight: 'bold',
  color: '#102a43',
  margin: '0 0 4px 0'
}));
sidebar.add(makeLabel('Interface for the generation of multitemporal multi-factor cost-surfaces', {
  fontSize: '13px',
  color: '#486581',
  margin: '0 0 7px 0'
}));
sidebar.add(helpLabel(
  'Workflow: define the area → choose time and factors → calculate → inspect layers → export. ' +
  'Every established parameter is already entered as its default.'
));

var calculateButton = ui.Button({
  label: 'CALCULATE COST SURFACE',
  onClick: calculateAndDisplay,
  style: {
    stretch: 'horizontal',
    fontWeight: 'bold',
    backgroundColor: '#0b6e4f',
    margin: '4px 0'
  }
});
sidebar.add(calculateButton);

var statusLabel = makeLabel('Loading the native AW3D resolution…', {
  color: '#8a4b08',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  margin: '5px 2px 7px 2px'
});
sidebar.add(statusLabel);


// Analysis area section.
var aoiSection = makeSection(
  sidebar,
  '1. Analysis area',
  'The red geometry is the active analysis area. Edit it directly, or erase it and draw one or more polygons/rectangles. Multiple drawn geometries are combined.',
  true
);

var resetAoiButton = ui.Button({
  label: 'Reset default area',
  onClick: function() {
    resetAnalysisArea();
    createProfileLineLayer();
    drawingTools.stop();
    drawingTools.setDrawModes(['polygon', 'rectangle']);
    invalidateProfileResults('The analysis area changed. Recalculate before profiling.');
    setProfileControlsEnabled(false);
    setStatus('Default analysis area restored.', 'ready');
  },
  style: {stretch: 'horizontal'}
});
var zoomAoiButton = ui.Button({
  label: 'Zoom to area',
  onClick: function() {
    try {
      appMap.centerObject(getAnalysisArea());
      setStatus('Map centred on the current analysis area.', 'ready');
    } catch (error) {
      setStatus('Area error: ' + error.message, 'error');
    }
  },
  style: {stretch: 'horizontal'}
});
aoiSection.add(ui.Panel({
  widgets: [resetAoiButton, zoomAoiButton],
  layout: ui.Panel.Layout.flow('horizontal'),
  style: {stretch: 'horizontal'}
}));


// Time section.
var timeSection = makeSection(
  sidebar,
  '2. Travel period',
  'Select the month in which travel will take place',
  true
);
selectRow(
  timeSection,
  'period',
  'Period',
  Object.keys(PERIODS),
  DEFAULTS.periodLabel,
  'Whole year uses day 1–364. Monthly choices use the established non-overlapping day ranges. -- WARNING -- : Annual-mean inputs conceal seasonal extremes and, when passed through nonlinear cost functions, produce different and potentially underestimated movement costs. Multi-month cost surface averages should be employed instead.'
);


// Factors section.
var factorsSection = makeSection(
  sidebar,
  '3. Cost factors',
  'Use = include in the final calculation. Show = make the factor visible initially. Used factors are also added to the map layer list when Show is off, so they can be inspected later.',
  true
);

var slopeBody = makeFactorCard(
  factorsSection,
  'slope',
  'Topographic slope',
  'Herzog sixth-degree polynomial applied to slope derived from the AW3D30 V4.1 DSM. Polynomial coefficients remain fixed.',
  false
);
parameterRow(slopeBody, 'slopeCap', 'Maximum slope cost', DEFAULTS.slopeCap,
  'Values above this values are assigned the cap.');

var noWaterBody = makeFactorCard(
  factorsSection,
  'noWater',
  'Lack of water / daytime heat',
  'Very sparse vegetation is combined with a WorldClim daytime temperature proxy. The raw 1–4 index is rescaled to the final 1–1.5 multiplier with the defaults.',
  false
);
parameterRow(noWaterBody, 'heatMinimum', 'Heat starts at (°C)', DEFAULTS.heatMinimum,
  'Heat exponent is 0 at or below this temperature.');
parameterRow(noWaterBody, 'heatMaximum', 'Full heat effect at (°C)', DEFAULTS.heatMaximum,
  'Heat exponent reaches its maximum at or above this temperature.');
parameterRow(noWaterBody, 'heatExponent', 'Maximum heat exponent', DEFAULTS.heatExponent,
  'Default 2: desert values up to 2 are raised to an exponent up to 2.');
parameterRow(noWaterBody, 'desertEvi', 'Desert EVI threshold', DEFAULTS.desertEvi,
  'EVI ≥ threshold gives 1; EVI 0–threshold is mapped from 2 to 1; negative EVI is assigned 1.');
parameterRow(noWaterBody, 'noWaterMaximum', 'Final maximum multiplier', DEFAULTS.noWaterMaximum,
  'The minimum multiplier is structurally fixed at 1.');
wideTextRow(noWaterBody, 'eviAnnualStart', 'Annual EVI start date', DEFAULTS.eviAnnualStart,
  'Earth Engine filterDate end dates are exclusive.');
wideTextRow(noWaterBody, 'eviAnnualEnd', 'Annual EVI end date', DEFAULTS.eviAnnualEnd, null);
wideTextRow(noWaterBody, 'eviMonthlyStart', 'Monthly EVI start date', DEFAULTS.eviMonthlyStart, null);
wideTextRow(noWaterBody, 'eviMonthlyEnd', 'Monthly EVI end date', DEFAULTS.eviMonthlyEnd,
  'The longer monthly interval compensates for incomplete single-month coverage.');

var attractionBody = makeFactorCard(
  factorsSection,
  'waterAttraction',
  'Water attraction (expensive)',
  'Reduces cost near high-EVI water indicators only inside the heat/aridity footprint. This convolution-based factor is disabled by default and its computational cost makes it best suited to national rather than continental areas.',
  false
);
parameterRow(attractionBody, 'attractionRadius', 'Convolution radius (km)', DEFAULTS.attractionRadius, null);
parameterRow(attractionBody, 'attractionEvi', 'Water-presence EVI', DEFAULTS.attractionEvi, null);
parameterRow(attractionBody, 'attractionMultiplier', 'Water cost multiplier', DEFAULTS.attractionMultiplier,
  'Must be >0 and ≤1; default 0.75 reduces local movement cost.');

var surfaceWaterBody = makeFactorCard(
  factorsSection,
  'surfaceWater',
  'Surface-water barrier',
  'JRC Global Surface Water occurrence is used annually. Monthly Recurrence is used for a selected month. Values are converted to 1–3.',
  false
);
parameterRow(surfaceWaterBody, 'surfaceWaterDivisor', 'Water percentage divisor', DEFAULTS.surfaceWaterDivisor,
  'The original 0–100 value is divided by this number and 1 is added.');

var snowBody = makeFactorCard(
  factorsSection,
  'snow',
  'Snow cover',
  'Mean MODIS MOD10A1 NDSI snow cover for the selected day-of-year period, converted to approximately 1–4.',
  false
);
parameterRow(snowBody, 'snowDivisor', 'Snow percentage divisor', DEFAULTS.snowDivisor,
  'The original 0–100 value is divided by this number and 1 is added.');

var sandBody = makeFactorCard(
  factorsSection,
  'looseSand',
  'Loose sand / dunes',
  'A custom probability raster is thresholded; retained probabilities contribute 1 + probability × coefficient.',
  false
);
wideTextRow(sandBody, 'sandAsset', 'Loose-sand image asset', DEFAULTS.sandAsset,
  'Replace this ID if the default user asset is not accessible. The source script identifies users/hao23/looseSand_RE as the Roman Empire alternative.');
parameterRow(sandBody, 'sandThreshold', 'Probability threshold', DEFAULTS.sandThreshold, null);
parameterRow(sandBody, 'sandCoefficient', 'Probability coefficient', DEFAULTS.sandCoefficient,
  'Default maximum multiplier is 1.35 when probability = 1.');

var coldBody = makeFactorCard(
  factorsSection,
  'cold',
  'Cold and wind chill',
  'Uses the same WorldClim daytime proxy as heat and TerraClimate wind speed. Wind chill is applied only within its validity conditions, otherwise the temperature proxy is retained.',
  false
);
parameterRow(coldBody, 'coldMinimum', 'Full cold effect at (°C)', DEFAULTS.coldMinimum, null);
parameterRow(coldBody, 'coldMaximum', 'No cold effect at (°C)', DEFAULTS.coldMaximum, null);
parameterRow(coldBody, 'coldMultiplier', 'Maximum cold multiplier', DEFAULTS.coldMultiplier, null);
coldBody.add(helpLabel(
  'Wind chill is calculated only when the temperature is ≤10 °C and wind speed is ≥4.8 km/h; these are fixed validity limits of the standard equation.'
));

var heightBody = makeFactorCard(
  factorsSection,
  'height',
  'High altitude',
  'Established non-linear elevation cost fitted to the 2000, 5050 and 5600 m calibration points. Curve coefficients remain fixed.',
  false
);
parameterRow(heightBody, 'heightThreshold', 'Altitude threshold (m)', DEFAULTS.heightThreshold,
  'The multiplier is 1 below or at this threshold.');

var reservoirBody = makeFactorCard(
  factorsSection,
  'reservoirs',
  'Modern reservoir replacement',
  'Reservoir cells replace the combined pre-reservoir cost with a fixed value, preserving the current mask-then-add logic.',
  false
);
wideTextRow(reservoirBody, 'damAsset', 'GRanD feature asset', DEFAULTS.damAsset,
  'Replace this ID if the default user asset is not accessible.');
parameterRow(reservoirBody, 'damProperty', 'Reservoir value property', DEFAULTS.damProperty, null);
parameterRow(reservoirBody, 'damReplacement', 'Reservoir replacement cost', DEFAULTS.damReplacement, null);

var seaBody = makeFactorCard(
  factorsSection,
  'sea',
  'Sea barrier',
  'AW3D30 MSK sea cells are supplemented by a JRC occurrence mask for the Caspian Sea. Sea cells are assigned the global maximum cost.',
  false
);
parameterRow(seaBody, 'seaOccurrence', 'Caspian occurrence threshold (%)', DEFAULTS.seaOccurrence, null);


// Output and normalisation section.
var outputSection = makeSection(
  sidebar,
  '4. Output and normalisation',
  'The default Float branch is scaled to 0.0001 and masked-cell fill value of 0.004 to allow large-areas to be calculated without deisproportionately increasing the raster size. The 8-bit branch is scaled to 0–255 and a fill value of 255.',
  true
);
parameterRow(outputSection, 'maxCost', 'Global maximum cost', DEFAULTS.maxCost,
  'The entry is rounded to a whole number. Raw values above it are assigned the threshold before output scaling.');
var outputTypeSelect = selectRow(
  outputSection,
  'outputType',
  'Output raster',
  ['Float', '8-bit'],
  DEFAULTS.outputType,
  null
);
checkboxRow(outputSection, 'showFinal', 'Show final cost surface initially', DEFAULTS.showFinal, null);
checkboxRow(outputSection, 'printSettings', 'Print settings to the Console', DEFAULTS.printSettings,
  'Useful for documenting and reproducing a run. Settings are also stored as image metadata.');

var floatOptionsPanel = ui.Panel({style: {shown: true, padding: '3px 0'}});
floatOptionsPanel.add(makeLabel('Float-output details', {
  fontWeight: 'bold',
  color: '#334e68',
  margin: '5px 4px 2px 4px'
}));
parameterRow(floatOptionsPanel, 'floatDecimals', 'Rounding decimal places', DEFAULTS.floatDecimals, null);
parameterRow(floatOptionsPanel, 'floatMultiplier', 'Post-rounding multiplier', DEFAULTS.floatMultiplier, null);
parameterRow(floatOptionsPanel, 'floatFill', 'Masked-cell fill value', DEFAULTS.floatFill, null);
outputSection.add(floatOptionsPanel);
outputTypeSelect.onChange(function(value) {
  floatOptionsPanel.style().set('shown', value === 'Float');
});


// Diagnostics section.
var diagnosticSection = makeSection(
  sidebar,
  '5. Diagnostic input layers',
  'Optional source/intermediate layers help users understand the selected parameters. They do not change the calculation.',
  false
);
checkboxRow(diagnosticSection, 'showDsm', 'Show AW3D elevation', false, null);
checkboxRow(diagnosticSection, 'showTemperature', 'Show daytime temperature proxy', false, null);
checkboxRow(diagnosticSection, 'showWind', 'Show TerraClimate wind speed', false, null);
checkboxRow(diagnosticSection, 'showEvi', 'Show multitemporal EVI', false, null);
checkboxRow(diagnosticSection, 'showHeat', 'Show heat exponent', false, null);
checkboxRow(diagnosticSection, 'showDesert', 'Show desert index', false, null);
checkboxRow(diagnosticSection, 'showNoWaterRaw', 'Show raw lack-of-water index', false, null);


// Export section.
var exportSection = makeSection(
  sidebar,
  '6. Export',
  'This button rebuilds the server-side image from the current controls, so the export cannot silently use stale settings. It creates a task in the Code Editor Tasks tab. The user needs to run it for the job to be sent to the server.',
  false
);

var nativeScaleLabel = helpLabel('Reading native AW3D resolution…');
exportSection.add(nativeScaleLabel);
parameterRow(exportSection, 'outputResolution', 'Requested resolution (m)', '',
  'Requests finer than the DSM are automatically set to the native DSM resolution, matching the source script.');
wideTextRow(exportSection, 'exportPrefix', 'Export name prefix', DEFAULTS.exportPrefix, null);
wideTextRow(exportSection, 'exportFolder', 'Google Drive folder (optional)', DEFAULTS.exportFolder,
  'Leave blank to preserve the current export behaviour.');

var exportButton = ui.Button({
  label: 'CREATE DRIVE EXPORT TASK',
  onClick: createDriveExportTask,
  disabled: true,
  style: {
    stretch: 'horizontal',
    fontWeight: 'bold',
    backgroundColor: '#1d4ed8',
    margin: '7px 0 3px 0'
  }
});
exportSection.add(exportButton);


// Cost-profile section.
var profileSection = makeSection(
  sidebar,
  '7. Cost profiles',
  'Calculate the surface first. Then press Draw / replace profile line, click the line vertices on the map and double-click the final vertex. The profile line is kept separate from the analysis polygon and never enters the cost calculation.',
  false
);

var profileModeSelect = ui.Select({
  items: [
    'Capped combined cost (model units)',
    'Export raster values',
    'Combined cost + used factors'
  ],
  value: 'Capped combined cost (model units)',
  style: {stretch: 'horizontal', margin: '1px 4px'}
});
profileSection.add(makeLabel('Profile contents', {
  fontWeight: 'bold',
  margin: '5px 4px 1px 4px'
}));
profileSection.add(profileModeSelect);
profileSection.add(helpLabel(
  'Model units show the capped combined cost before Float or 8-bit output scaling. ' +
  'The factor option but includes only factors used in the calculated surface '
));

var profilePointSlider = ui.Slider({
  min: 2,
  max: 1000,
  value: 100,
  step: 1,
  style: {stretch: 'horizontal', margin: '1px 4px'}
});
profileSection.add(makeLabel('Number of regularly spaced sample points', {
  fontWeight: 'bold',
  margin: '5px 4px 1px 4px'
}));
profileSection.add(profilePointSlider);

var profileScaleBox = ui.Textbox({
  value: '',
  style: {stretch: 'horizontal', margin: '1px 4px'}
});
profileSection.add(makeLabel('Sampling scale (m)', {
  fontWeight: 'bold',
  margin: '5px 4px 1px 4px'
}));
profileSection.add(profileScaleBox);
profileSection.add(helpLabel(
  'The native AW3D scale is entered automatically. A coarser scale can reduce computation for long profiles.'
));

var drawProfileButton = ui.Button({
  label: 'DRAW / REPLACE PROFILE LINE',
  onClick: startProfileDrawing,
  disabled: true,
  style: {stretch: 'horizontal', fontWeight: 'bold', margin: '5px 0 2px 0'}
});
var generateProfileButton = ui.Button({
  label: 'GENERATE PROFILE',
  onClick: generateCostProfile,
  disabled: true,
  style: {
    stretch: 'horizontal',
    fontWeight: 'bold',
    backgroundColor: '#7c3aed',
    margin: '2px 0'
  }
});
var clearProfileButton = ui.Button({
  label: 'Clear profile line',
  onClick: clearProfileLine,
  style: {stretch: 'horizontal'}
});
var profileCsvButton = ui.Button({
  label: 'CREATE PROFILE CSV TASK',
  onClick: createProfileCsvTask,
  disabled: true,
  style: {stretch: 'horizontal', fontWeight: 'bold', margin: '2px 0'}
});

profileSection.add(drawProfileButton);
profileSection.add(generateProfileButton);
profileSection.add(clearProfileButton);
profileSection.add(profileCsvButton);

var profileStatusLabel = helpLabel(
  'Calculate a cost surface to activate the profile tools.'
);
profileSection.add(profileStatusLabel);

var profileChartPanel = ui.Panel({
  style: {
    shown: false,
    stretch: 'horizontal',
    margin: '5px 0 0 0'
  }
});
profileSection.add(profileChartPanel);


// Reset and repeated calculate controls.
var resetSettingsButton = ui.Button({
  label: 'Restore all established defaults',
  onClick: restoreDefaults,
  style: {stretch: 'horizontal', margin: '8px 0 3px 0'}
});
sidebar.add(resetSettingsButton);
sidebar.add(ui.Button({
  label: 'CALCULATE COST SURFACE',
  onClick: calculateAndDisplay,
  style: {
    stretch: 'horizontal',
    fontWeight: 'bold',
    backgroundColor: '#0b6e4f',
    margin: '4px 0'
  }
}));


// -----------------------------------------------------------------------------
// 5. READ AND VALIDATE THE GUI SETTINGS
// -----------------------------------------------------------------------------

function readModelSettings() {
  var periodLabel = controls.period.getValue();
  var period = PERIODS[periodLabel];
  if (!period) throw new Error('Select a valid travel period.');

  var settings = {
    period: period,
    // Preserve Math.round(maxCostPrompt) from the source script.
    maxCost: Math.round(
      readNumber('maxCost', 'Global maximum cost', 0.000001, null, false)
    ),
    outputType: controls.outputType.getValue(),
    showFinal: controls.showFinal.getValue(),
    printSettings: controls.printSettings.getValue(),
    factors: {},
    diagnostics: {
      dsm: controls.showDsm.getValue(),
      temperature: controls.showTemperature.getValue(),
      wind: controls.showWind.getValue(),
      evi: controls.showEvi.getValue(),
      heat: controls.showHeat.getValue(),
      desert: controls.showDesert.getValue(),
      noWaterRaw: controls.showNoWaterRaw.getValue()
    }
  };

  var factorKeys = Object.keys(FACTOR_DEFAULTS);
  var selectedCount = 0;
  var i;
  for (i = 0; i < factorKeys.length; i++) {
    var key = factorKeys[i];
    settings.factors[key] = {
      use: factorControls[key].use.getValue(),
      show: factorControls[key].show.getValue()
    };
    if (settings.factors[key].use) selectedCount++;
  }
  if (selectedCount === 0) {
    throw new Error('Select at least one factor in the Use column.');
  }

  settings.slopeCap = readNumber('slopeCap', 'Maximum slope cost', 0.000001, null, false);
  settings.snowDivisor = readNumber('snowDivisor', 'Snow percentage divisor', 0.000001, null, false);
  settings.seaOccurrence = readNumber('seaOccurrence', 'Caspian occurrence threshold', 0, 100, false);

  settings.damAsset = readText('damAsset', 'GRanD feature asset', factorIsNeeded(settings, 'reservoirs'));
  settings.damProperty = readText('damProperty', 'Reservoir value property', factorIsNeeded(settings, 'reservoirs'));
  settings.damReplacement = readNumber('damReplacement', 'Reservoir replacement cost', 0, null, false);

  settings.coldMinimum = readNumber('coldMinimum', 'Full cold-effect temperature', null, null, false);
  settings.coldMaximum = readNumber('coldMaximum', 'No cold-effect temperature', null, null, false);
  if (settings.coldMinimum >= settings.coldMaximum) {
    throw new Error('Full cold-effect temperature must be lower than no cold-effect temperature.');
  }
  settings.coldMultiplier = readNumber('coldMultiplier', 'Maximum cold multiplier', 1, null, false);

  settings.sandAsset = readText('sandAsset', 'Loose-sand image asset', factorIsNeeded(settings, 'looseSand'));
  settings.sandThreshold = readNumber('sandThreshold', 'Loose-sand probability threshold', 0, 1, false);
  settings.sandCoefficient = readNumber('sandCoefficient', 'Loose-sand probability coefficient', 0, null, false);

  settings.heatMinimum = readNumber('heatMinimum', 'Heat-start temperature', null, null, false);
  settings.heatMaximum = readNumber('heatMaximum', 'Full heat-effect temperature', null, null, false);
  if (settings.heatMinimum >= settings.heatMaximum) {
    throw new Error('Heat-start temperature must be lower than full heat-effect temperature.');
  }
  settings.heatExponent = readNumber('heatExponent', 'Maximum heat exponent', 0.000001, 10, false);
  settings.desertEvi = readNumber('desertEvi', 'Desert EVI threshold', 0.000001, 1, false);
  settings.noWaterMaximum = readNumber('noWaterMaximum', 'Final lack-of-water multiplier', 1, null, false);

  settings.eviAnnualStart = readDate('eviAnnualStart', 'Annual EVI start date');
  settings.eviAnnualEnd = readDate('eviAnnualEnd', 'Annual EVI end date');
  settings.eviMonthlyStart = readDate('eviMonthlyStart', 'Monthly EVI start date');
  settings.eviMonthlyEnd = readDate('eviMonthlyEnd', 'Monthly EVI end date');
  if (settings.eviAnnualStart >= settings.eviAnnualEnd) {
    throw new Error('Annual EVI start date must be earlier than its end date.');
  }
  if (settings.eviMonthlyStart >= settings.eviMonthlyEnd) {
    throw new Error('Monthly EVI start date must be earlier than its end date.');
  }

  settings.attractionRadius = readNumber('attractionRadius', 'Water-attraction radius', 0.000001, null, false);
  settings.attractionEvi = readNumber('attractionEvi', 'Water-presence EVI', -1, 1, false);
  settings.attractionMultiplier = readNumber('attractionMultiplier', 'Water cost multiplier', 0.000001, 1, false);

  settings.surfaceWaterDivisor = readNumber('surfaceWaterDivisor', 'Surface-water divisor', 0.000001, null, false);
  settings.heightThreshold = readNumber('heightThreshold', 'Altitude threshold', null, null, false);

  settings.floatDecimals = readNumber('floatDecimals', 'Float rounding decimal places', 0, 10, true);
  settings.floatMultiplier = readNumber('floatMultiplier', 'Float post-rounding multiplier', 0.000000000001, null, false);
  settings.floatFill = readNumber('floatFill', 'Float masked-cell fill value', 0, null, false);

  return settings;
}


// -----------------------------------------------------------------------------
// 6. MODEL CALCULATION
// -----------------------------------------------------------------------------

function buildModel(settings, geometry) {
  var period = settings.period;
  var periodFilter = ee.Filter.dayOfYear(period.startDay, period.endDay);
  var layers = {};
  var diagnostics = {};

  // DIGITAL SURFACE MODEL. Preserve the projection of an original AW3D tile
  // rather than using the default projection returned by mosaic().
  var aw3d = ee.ImageCollection('JAXA/ALOS/AW3D30/V4_1')
    .filterBounds(geometry);
  var elevation = aw3d.select('DSM');
  var projection = elevation.first().select(0).projection();
  var dsm = elevation
    .mosaic()
    .setDefaultProjection(projection)
    .clip(geometry);
  diagnostics.dsm = dsm.rename('elevation_m');

  // Dependencies shared by several factors and diagnostics.
  var needNoWater = factorIsNeeded(settings, 'noWater') ||
    factorIsNeeded(settings, 'waterAttraction') ||
    settings.diagnostics.heat || settings.diagnostics.desert ||
    settings.diagnostics.noWaterRaw;
  var needTemperature = factorIsNeeded(settings, 'cold') || needNoWater ||
    settings.diagnostics.temperature;
  var needWind = factorIsNeeded(settings, 'cold') || settings.diagnostics.wind;
  var needEvi = needNoWater || settings.diagnostics.evi;

  // TOPOGRAPHIC SLOPE.
  if (factorIsNeeded(settings, 'slope')) {
    var slope = ee.Terrain.slope(dsm);
    var slopeRadians = slope.multiply(3.1415926536).divide(180);
    var slopeGradient = slopeRadians.tan();
    var costSlopeUncapped = slopeGradient.pow(6).multiply(1337.8)
      .add(slopeGradient.pow(5).multiply(278.19))
      .subtract(slopeGradient.pow(4).multiply(517.39))
      .subtract(slopeGradient.pow(3).multiply(78.199))
      .add(slopeGradient.pow(2).multiply(93.419))
      .add(slopeGradient.multiply(19.825))
      .add(1.64)
      .select(['slope'], ['cost']);
    layers.slope = costSlopeUncapped.gt(settings.slopeCap).multiply(settings.slopeCap)
      .add(costSlopeUncapped.lte(settings.slopeCap).multiply(costSlopeUncapped))
      .rename('slope_multiplier');
  }

  // SNOW.
  if (factorIsNeeded(settings, 'snow')) {
    var snowCollection = ee.ImageCollection('MODIS/061/MOD10A1')
      .select('NDSI_Snow_Cover')
      .filter(periodFilter)
      .filterBounds(geometry)
      .map(function(img) {
        return img.updateMask(img.lte(100));
      });

    var snowBase = snowCollection
      .reduce(ee.Reducer.mean())
      .unmask(0)
      .clip(geometry);

    layers.snow = snowBase.divide(settings.snowDivisor)
      .add(ee.Image(1))
      .rename('snow_multiplier');
  } 

  // WORLDCLIM DAYTIME TEMPERATURE PROXY: (tavg + tmax) / 2.
  var temperature;
  if (needTemperature) {
    var temperatureBands;
    if (period.key === 'yr') {
      temperatureBands = ee.ImageCollection('WORLDCLIM/V1/MONTHLY')
        .select(['tavg', 'tmax'])
        .mean()
        .multiply(0.1);
    } else {
      temperatureBands = ee.Image('WORLDCLIM/V1/MONTHLY/' + period.altNum)
        .select(['tavg', 'tmax'])
        .multiply(0.1);
    }
    temperature = temperatureBands.select('tavg')
      .add(temperatureBands.select('tmax'))
      .divide(2)
      .rename('daytime_temperature_c');
    diagnostics.temperature = temperature.clip(geometry);
  }

  // TERRACLIMATE WIND SPEED. 0.036 combines the band scale factor (0.01)
  // with conversion from m/s to km/h (3.6).
  var windSpeed;
  if (needWind) {
    windSpeed = ee.ImageCollection('IDAHO_EPSCOR/TERRACLIMATE')
      .select('vs')
      .filter(periodFilter)
      .filterBounds(geometry)
      .reduce(ee.Reducer.mean())
      .unmask(0)
      .multiply(0.036)
      .clip(geometry)
      .rename('wind_speed_kmh');
    diagnostics.wind = windSpeed;
  }

  // COLD AND WIND CHILL.
  if (factorIsNeeded(settings, 'cold')) {
    var windPower = windSpeed.pow(0.16);
    var windChillValues = ee.Image(13.12)
      .add(ee.Image(0.6215).multiply(temperature))
      .subtract(ee.Image(11.37).multiply(windPower))
      .add(ee.Image(0.3965).multiply(temperature).multiply(windPower));

    var validWindChill = temperature
      .lte(WIND_CHILL_MAX_TEMPERATURE_C)
      .and(windSpeed.gte(WIND_CHILL_MIN_SPEED_KMH));

    var windChill = validWindChill
      .multiply(windChillValues)
      .add(validWindChill.not().multiply(temperature));

    var cold1 = windChill.gte(settings.coldMinimum);
    var cold2 = windChill.lte(settings.coldMaximum);
    var cold3 = windChill.lt(settings.coldMinimum).multiply(settings.coldMinimum);
    var cold4 = windChill.gt(settings.coldMaximum).multiply(settings.coldMaximum);
    var constrainedCold = cold1.multiply(cold2).multiply(windChill)
      .add(cold3)
      .add(cold4);
    var coldPosition = constrainedCold.subtract(settings.coldMinimum)
      .divide(settings.coldMaximum - settings.coldMinimum);
    layers.cold = ee.Image(settings.coldMultiplier)
      .subtract(coldPosition.multiply(settings.coldMultiplier - 1))
      .rename('cold_multiplier');
  }

  // MULTITEMPORAL EVI.
  var evi;
  if (needEvi) {
    var eviStart = period.key === 'yr' ? settings.eviAnnualStart : settings.eviMonthlyStart;
    var eviEnd = period.key === 'yr' ? settings.eviAnnualEnd : settings.eviMonthlyEnd;
    evi = ee.ImageCollection('LANDSAT/COMPOSITES/C02/T1_L2_8DAY_EVI')
      .filterDate(eviStart, eviEnd)
      .filter(periodFilter)
      .filterBounds(geometry)
      .reduce(ee.Reducer.mean())
      .unmask(0)
      .clip(geometry)
      .rename('evi');
    diagnostics.evi = evi;
  }

  // DESERT, HEAT, AND LACK-OF-WATER MULTIPLIER.
  var heat;
  var desert;
  var noWater;
  if (needNoWater) {
    heat = temperature
      .clamp(settings.heatMinimum, settings.heatMaximum)
      .subtract(settings.heatMinimum)
      .divide(settings.heatMaximum - settings.heatMinimum)
      .multiply(settings.heatExponent)
      .rename('heat_exponent');

    desert = ee.Image(2)
      .subtract(evi.clamp(0, settings.desertEvi).divide(settings.desertEvi))
      .where(evi.lt(0), 1)
      .rename('desert_index');

    var noWaterRaw = desert.pow(heat).rename('lack_of_water_raw');
    var rawMaximum = Math.pow(2, settings.heatExponent);
    noWater = noWaterRaw
      .subtract(1)
      .divide(rawMaximum - 1)
      .multiply(settings.noWaterMaximum - 1)
      .add(1)
      .clamp(1, settings.noWaterMaximum)
      .rename('lack_of_water_multiplier');

    diagnostics.heat = heat.clip(geometry);
    diagnostics.desert = desert.clip(geometry);
    diagnostics.noWaterRaw = noWaterRaw.clip(geometry);
    layers.noWater = noWater;
  }

  // WATER ATTRACTION. The aridity/heat footprint is computed as a dependency
  // even when the lack-of-water multiplier itself is not selected for use.
  if (factorIsNeeded(settings, 'waterAttraction')) {
    var waterConvolution = noWater.gt(1).focal_median({
      kernel: ee.Kernel.circle({
        radius: settings.attractionRadius * 1000,
        units: 'meters'
      })
    });
    layers.waterAttraction = waterConvolution
      .multiply(evi.gte(settings.attractionEvi))
      .remap([0, 1], [1, settings.attractionMultiplier])
      .rename('water_attraction_multiplier');
  }

  // SURFACE WATER.
  if (factorIsNeeded(settings, 'surfaceWater')) {
    var waterRecurrence;
    if (period.key === 'yr') {
      waterRecurrence = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
        .select('occurrence')
        .unmask(0);
    } else {
      waterRecurrence = ee.Image(
        'JRC/GSW1_4/MonthlyRecurrence/monthly_recurrence_' + period.monthNum
      ).select('monthly_recurrence').unmask(0);
    }
    layers.surfaceWater = waterRecurrence
      .divide(settings.surfaceWaterDivisor)
      .add(ee.Image(1))
      .clip(geometry)
      .rename('surface_water_multiplier');
  }

  // LOOSE SAND OR DUNES.
  if (factorIsNeeded(settings, 'looseSand')) {
    var sandProbabilityRaw = ee.Image(settings.sandAsset);
    var sandProbabilityFilled = ee.Image.constant(0)
      .where(sandProbabilityRaw.mask(), sandProbabilityRaw)
      .clip(geometry);
    layers.looseSand = ee.Image(1)
      .add(
        sandProbabilityFilled.gte(settings.sandThreshold)
          .multiply(sandProbabilityFilled.multiply(settings.sandCoefficient))
      )
      .clip(geometry)
      .rename('loose_sand_multiplier');
  } 

  // HEIGHT ABOVE THE SELECTED THRESHOLD. Curve coefficients are the established
  // fit to (2000,1), (5050,1.24), and (5600,1.39).
  if (factorIsNeeded(settings, 'height')) {
    layers.height = ee.Image(-0.0170146)
      .subtract(
        ee.Image(0.004039874802622)
          .multiply(
            ee.Image(1).subtract(
              ee.Image(2.718281828459)
                .pow(dsm.multiply(ee.Image(0.0008254486)))
            )
          )
      )
      .multiply(dsm.gt(settings.heightThreshold))
      .add(ee.Image(1))
      .rename('height_multiplier');
  }

  // MODERN RESERVOIRS. Current reservoir cells are set to a replacement cost.
  var reservoirMask;
  var reservoirReplacement;
  if (factorIsNeeded(settings, 'reservoirs')) {
    reservoirMask = ee.FeatureCollection(settings.damAsset)
      .reduceToImage({
        properties: [settings.damProperty],
        reducer: ee.Reducer.first()
      })
      .unmask(0)
      .remap([0, 1], [1, 0])
      .clip(geometry);
    reservoirReplacement = reservoirMask
      .remap([0, 1], [settings.damReplacement, 0])
      .float()
      .rename('reservoir_replacement');
    layers.reservoirs = reservoirReplacement;
  }

  // SEA MASK, INCLUDING THE CASPIAN SUPPLEMENT.
  var seaCost;
  if (factorIsNeeded(settings, 'sea')) {
    var alosMask = aw3d.select('MSK')
      .mosaic()
      .clip(geometry)
      .setDefaultProjection(projection);
    var alosSea = alosMask.bitwiseAnd(3)
      .eq(3)
      .unmask(0)
      .toByte()
      .rename('allSeas');

    var caspianRegion = ee.Geometry.Rectangle([46.0, 36.0, 55.2, 47.8], null, false);
    var caspianSea = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
      .select('occurrence')
      .clip(caspianRegion)
      .unmask(0)
      .gte(settings.seaOccurrence)
      .toByte()
      .rename('allSeas');
    var allSeas = ee.ImageCollection([alosSea, caspianSea]).mosaic();
    seaCost = allSeas.multiply(settings.maxCost)
      .float()
      .rename('sea_cost');
    layers.sea = seaCost;
  }

  // COMBINE FACTORS IN THE SAME ORDER AS THE SOURCE SCRIPT.
  var rawCost = settings.factors.slope.use ?
    layers.slope.rename('cost') : ee.Image(1).rename('cost').clip(geometry);

  if (settings.factors.noWater.use) rawCost = rawCost.multiply(layers.noWater);
  if (settings.factors.waterAttraction.use) rawCost = rawCost.multiply(layers.waterAttraction);
  if (settings.factors.surfaceWater.use) rawCost = rawCost.multiply(layers.surfaceWater);
  if (settings.factors.snow.use) rawCost = rawCost.multiply(layers.snow);
  if (settings.factors.looseSand.use) rawCost = rawCost.multiply(layers.looseSand);
  if (settings.factors.cold.use) rawCost = rawCost.multiply(layers.cold);
  if (settings.factors.height.use) rawCost = rawCost.multiply(layers.height);
  if (settings.factors.reservoirs.use) {
    rawCost = rawCost.multiply(reservoirMask).add(reservoirReplacement);
  }
  if (settings.factors.sea.use) rawCost = rawCost.add(seaCost);
  rawCost = rawCost.rename('cost');

  // MAXIMUM ASSIGNMENT AND OUTPUT SCALING.
  var cappedCost = rawCost.gt(settings.maxCost).multiply(settings.maxCost)
    .add(rawCost.lte(settings.maxCost).multiply(rawCost))
    .rename('cost');

  var output;
  if (settings.outputType === '8-bit') {
    output = cappedCost.divide(settings.maxCost)
      .multiply(255)
      .byte()
      .clip(geometry)
      .unmask(255)
      .rename('cost');
  } else {
    var roundingPower = ee.Number(10).pow(settings.floatDecimals);
    output = cappedCost.multiply(roundingPower)
      .round()
      .divide(roundingPower)
      .multiply(settings.floatMultiplier)
      .clip(geometry)
      .unmask(settings.floatFill)
      .rename('cost');
  }

  var usedFactors = [];
  var factorNames = Object.keys(settings.factors);
  var j;
  for (j = 0; j < factorNames.length; j++) {
    if (settings.factors[factorNames[j]].use) usedFactors.push(factorNames[j]);
  }
  output = output.set({
    model: 'Multi-factor Probabilistic Route Modelling GUI',
    period: period.name,
    output_type: settings.outputType,
    maximum_cost: settings.maxCost,
    used_factors: usedFactors.join(','),
    settings_json: JSON.stringify(settings),
    created_utc: new Date().toISOString()
  });

  return {
    output: output,
    rawCost: rawCost,
    cappedCost: cappedCost,
    layers: layers,
    diagnostics: diagnostics,
    projection: projection,
    geometry: geometry,
    settings: settings
  };
}


// -----------------------------------------------------------------------------
// 7. MAP RENDERING
// -----------------------------------------------------------------------------

var legendPanel = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px',
    backgroundColor: '#ffffff'
  }
});
appMap.add(legendPanel);

function addFactorLayer(result, settings, key, image, visualization, name) {
  if (!image) return;
  var flags = settings.factors[key];
  if (!flags.use && !flags.show) return;
  var suffix = flags.use ? '' : ' [display only]';
  appMap.addLayer(image, visualization, 'Factor – ' + name + suffix, flags.show);
}

function renderResult(result) {
  var settings = result.settings;
  appMap.layers().reset([]);

  // Diagnostic inputs are placed at the bottom of the layer stack.
  if (settings.diagnostics.dsm) {
    appMap.addLayer(result.diagnostics.dsm, {
      min: 0, max: 5600,
      palette: ['0b3d2e', '4d9221', 'f1b95b', 'a6611a', 'ffffff']
    }, 'Input – AW3D elevation (m)', true);
  }
  if (settings.diagnostics.temperature) {
    appMap.addLayer(result.diagnostics.temperature, {
      min: -20, max: 45,
      palette: ['313695', '74add1', 'ffffbf', 'f46d43', 'a50026']
    }, 'Input – daytime temperature proxy (°C)', true);
  }
  if (settings.diagnostics.wind) {
    appMap.addLayer(result.diagnostics.wind, {
      min: 0, max: 40,
      palette: ['ffffff', 'abd9e9', '2c7bb6', '253494']
    }, 'Input – wind speed (km/h)', true);
  }
  if (settings.diagnostics.evi) {
    appMap.addLayer(result.diagnostics.evi, {
      min: 0, max: 0.4,
      palette: ['8c510a', 'dfc27d', 'f6e8c3', '80cdc1', '01665e']
    }, 'Input – multitemporal EVI', true);
  }
  if (settings.diagnostics.heat) {
    appMap.addLayer(result.diagnostics.heat, {
      min: 0, max: settings.heatExponent,
      palette: ['ffffff', 'fee08b', 'f46d43', 'a50026']
    }, 'Intermediate – heat exponent', true);
  }
  if (settings.diagnostics.desert) {
    appMap.addLayer(result.diagnostics.desert, {
      min: 1, max: 2,
      palette: ['1a9850', 'fee08b', 'd73027']
    }, 'Intermediate – desert index', true);
  }
  if (settings.diagnostics.noWaterRaw) {
    appMap.addLayer(result.diagnostics.noWaterRaw, {
      min: 1, max: Math.pow(2, settings.heatExponent),
      palette: MULTIPLIER_PALETTE
    }, 'Intermediate – raw lack-of-water index', true);
  }

  addFactorLayer(result, settings, 'slope', result.layers.slope,
    {min: 1.64, max: 10, palette: MULTIPLIER_PALETTE}, 'topographic slope');
  addFactorLayer(result, settings, 'noWater', result.layers.noWater,
    {min: 1, max: settings.noWaterMaximum, palette: MULTIPLIER_PALETTE}, 'lack of water');
  addFactorLayer(result, settings, 'waterAttraction', result.layers.waterAttraction,
    {min: settings.attractionMultiplier, max: 1, palette: ['2166ac', 'ffffff']}, 'water attraction');
  addFactorLayer(result, settings, 'surfaceWater', result.layers.surfaceWater,
    {min: 1, max: 4, palette: MULTIPLIER_PALETTE}, 'surface water');
  addFactorLayer(result, settings, 'snow', result.layers.snow,
    {min: 1, max: 4, palette: ['ffffff', 'b3d8ff', '2166ac']}, 'snow');
  addFactorLayer(result, settings, 'looseSand', result.layers.looseSand,
    {min: 1, max: 1 + settings.sandCoefficient, palette: ['ffffff', 'fee08b', 'd8a400']}, 'loose sand');
  addFactorLayer(result, settings, 'cold', result.layers.cold,
    {min: 1, max: settings.coldMultiplier, palette: ['ffffff', '91bfdb', '313695']}, 'cold');
  addFactorLayer(result, settings, 'height', result.layers.height,
    {min: 1, max: 1.5, palette: MULTIPLIER_PALETTE}, 'high altitude');

  var reservoirDisplay = result.layers.reservoirs ?
    result.layers.reservoirs.updateMask(result.layers.reservoirs.gt(0)) : null;
  addFactorLayer(result, settings, 'reservoirs', reservoirDisplay,
    {min: 0, max: settings.damReplacement, palette: ['7b3294']}, 'reservoir replacement');

  var seaDisplay = result.layers.sea ?
    result.layers.sea.updateMask(result.layers.sea.gt(0)) : null;
  addFactorLayer(result, settings, 'sea', seaDisplay,
    {min: 0, max: settings.maxCost, palette: ['2c7fb8']}, 'sea barrier');

  var finalVisualization = settings.outputType === '8-bit' ?
    {min: 1, max: 150, palette: COST_PALETTE} :
    {min: 0.0001, max: 0.001, palette: COST_PALETTE};
  appMap.addLayer(
    result.output,
    finalVisualization,
    'FINAL cost surface – ' + settings.period.name + ' – ' + settings.outputType,
    settings.showFinal
  );
  updateLegend(settings);
}

function updateLegend(settings) {
  legendPanel.clear();
  legendPanel.add(makeLabel('Final cost surface', {
    fontWeight: 'bold',
    color: '#102a43',
    margin: '0 0 4px 0'
  }));
  var rangeText = settings.outputType === '8-bit' ?
    'Display: 1–150 (output: 0–255)' :
    'Display: 0.0001–0.001';
  legendPanel.add(makeLabel(rangeText, {fontSize: '10px', color: '#486581'}));

  var swatches = [];
  var i;
  for (i = 0; i < COST_PALETTE.length; i++) {
    swatches.push(makeLabel(' ', {
      width: '25px',
      height: '10px',
      backgroundColor: '#' + COST_PALETTE[i],
      margin: '3px 0 0 0'
    }));
  }
  legendPanel.add(ui.Panel({
    widgets: swatches,
    layout: ui.Panel.Layout.flow('horizontal')
  }));
  legendPanel.add(ui.Panel({
    widgets: [
      makeLabel('Lower cost', {fontSize: '10px', width: '75px'}),
      makeLabel('Higher cost', {fontSize: '10px', textAlign: 'right', width: '75px'})
    ],
    layout: ui.Panel.Layout.flow('horizontal')
  }));
}


// -----------------------------------------------------------------------------
// COST-PROFILE DRAWING, SAMPLING, CHARTING, AND EXPORT
// -----------------------------------------------------------------------------

function setProfileStatus(message, kind) {
  var colors = {
    ready: '#52606d',
    working: '#8a4b08',
    success: '#176b3a',
    error: '#b42318'
  };
  profileStatusLabel.setValue(message);
  profileStatusLabel.style().set('color', colors[kind] || colors.ready);
}

function setProfileControlsEnabled(enabled) {
  drawProfileButton.setDisabled(!enabled);
  generateProfileButton.setDisabled(!enabled);
  if (!enabled) profileCsvButton.setDisabled(true);
}

function removeMapLayersNamed(name) {
  var layers = appMap.layers();
  var i;
  for (i = layers.length() - 1; i >= 0; i--) {
    if (layers.get(i).getName() === name) {
      layers.remove(layers.get(i));
    }
  }
}

function invalidateProfileResults(message) {
  profileState.runId++;
  profileState.samples = null;
  profileState.bandNames = null;
  profileState.selectors = null;
  profileState.sourceLabel = null;
  profileState.requestedPoints = null;
  profileState.periodName = null;
  profileState.sourceTag = null;
  profileState.samplingScale = null;
  profileCsvButton.setDisabled(true);
  profileChartPanel.clear();
  profileChartPanel.style().set('shown', false);
  removeMapLayersNamed('PROFILE sample points');
  if (message) setProfileStatus(message, 'ready');
}

function startProfileDrawing() {
  try {
    if (!appState.result) {
      throw new Error('Calculate a cost surface before drawing a profile.');
    }
    ensureProfileLineLayer();
    drawingTools.stop();
    profileState.lineLayer.geometries().reset([]);
    invalidateProfileResults();
    drawingTools.setDrawModes(['line']);
    drawingTools.setSelected(profileState.lineLayer);
    // setShape starts interactive drawing mode in the Code Editor.
    drawingTools.setShape('line');
    setProfileStatus(
      'Click the line vertices on the map; double-click the final vertex to finish.',
      'working'
    );
  } catch (error) {
    setProfileStatus('Profile error: ' + error.message, 'error');
  }
}

function clearProfileLine() {
  ensureProfileLineLayer();
  drawingTools.stop();
  profileState.lineLayer.geometries().reset([]);
  drawingTools.setDrawModes(['polygon', 'rectangle']);
  drawingTools.setSelected(null);
  invalidateProfileResults('Profile line and sampled results cleared.');
}

function getProfileLine() {
  ensureProfileLineLayer();
  var geometries = profileState.lineLayer.geometries();
  if (geometries.length() === 0) {
    throw new Error('Draw a profile line first.');
  }
  return ee.Geometry(geometries.get(geometries.length() - 1));
}

drawingTools.onDraw(function(geometry, layer) {
  if (layer !== profileState.lineLayer) return;

  // Retain only the most recently drawn line.
  while (layer.geometries().length() > 1) {
    layer.geometries().remove(layer.geometries().get(0));
  }
  drawingTools.stop();
  drawingTools.setDrawModes(['polygon', 'rectangle']);
  drawingTools.setSelected(null);
  invalidateProfileResults();
  setProfileStatus(
    'Profile line ready. Choose the contents and sampling settings, then generate the profile.',
    'success'
  );
});

drawingTools.onEdit(function(geometry, layer) {
  if (layer !== profileState.lineLayer) return;
  invalidateProfileResults();
  setProfileStatus('Profile line edited. Generate the profile again.', 'ready');
});

drawingTools.onErase(function(geometry, layer) {
  if (layer !== profileState.lineLayer) return;
  invalidateProfileResults('Profile line erased. Draw a new line to continue.');
});

// Creates regularly spaced points along a user-drawn polyline. This preserves
// the profile logic of the earlier script while adding explicit coordinates to
// the CSV output.
function makePointsAlongLine(line, nPoints) {
  line = ee.Geometry(line);

  var coords = ee.List(line.coordinates());
  var nCoords = coords.length();
  var segmentIds = ee.List.sequence(0, nCoords.subtract(2));

  var rawSegments = ee.FeatureCollection(segmentIds.map(function(i) {
    i = ee.Number(i);
    var c1 = ee.List(coords.get(i));
    var c2 = ee.List(coords.get(i.add(1)));
    var p1 = ee.Geometry.Point(c1);
    var p2 = ee.Geometry.Point(c2);
    var segmentLength = p1.distance(p2, 1);

    return ee.Feature(null, {
      segment_id: i,
      x1: c1.get(0),
      y1: c1.get(1),
      x2: c2.get(0),
      y2: c2.get(1),
      segment_length_m: segmentLength
    });
  })).filter(ee.Filter.gt('segment_length_m', 0));

  var initial = ee.Dictionary({
    cumulative: ee.Number(0),
    features: ee.List([])
  });

  var cumulativeSegments = ee.Dictionary(
    rawSegments.toList(rawSegments.size()).iterate(function(feature, state) {
      feature = ee.Feature(feature);
      state = ee.Dictionary(state);

      var startDistance = ee.Number(state.get('cumulative'));
      var segmentLength = ee.Number(feature.get('segment_length_m'));
      var endDistance = startDistance.add(segmentLength);
      var newFeature = feature.set({
        start_m: startDistance,
        end_m: endDistance
      });

      return ee.Dictionary({
        cumulative: endDistance,
        features: ee.List(state.get('features')).add(newFeature)
      });
    }, initial)
  );

  var segmentCollection = ee.FeatureCollection(
    ee.List(cumulativeSegments.get('features'))
  );
  var totalLength = ee.Number(cumulativeSegments.get('cumulative'));
  var n = ee.Number(nPoints);
  var stepDistance = totalLength.divide(n.subtract(1));
  var epsilon = ee.Number(0.001);
  var maxLookupDistance = ee.Number(
    ee.Algorithms.If(
      totalLength.gt(epsilon),
      totalLength.subtract(epsilon),
      totalLength
    )
  );

  var pointIds = ee.List.sequence(0, n.subtract(1));
  return ee.FeatureCollection(pointIds.map(function(i) {
    i = ee.Number(i);
    var distanceAlongLine = i.multiply(stepDistance);
    var lookupDistance = distanceAlongLine.min(maxLookupDistance);
    var matchingSegments = segmentCollection
      .filter(ee.Filter.lte('start_m', lookupDistance))
      .filter(ee.Filter.gt('end_m', lookupDistance));
    var segment = ee.Feature(
      ee.Algorithms.If(
        matchingSegments.size().gt(0),
        matchingSegments.first(),
        segmentCollection.sort('start_m', false).first()
      )
    );

    var segmentStart = ee.Number(segment.get('start_m'));
    var segmentLength = ee.Number(segment.get('segment_length_m'));
    var fraction = lookupDistance.subtract(segmentStart).divide(segmentLength);
    var x1 = ee.Number(segment.get('x1'));
    var y1 = ee.Number(segment.get('y1'));
    var x2 = ee.Number(segment.get('x2'));
    var y2 = ee.Number(segment.get('y2'));
    var x = x1.add(x2.subtract(x1).multiply(fraction));
    var y = y1.add(y2.subtract(y1).multiply(fraction));

    return ee.Feature(ee.Geometry.Point([x, y]), {
      point_id: i.add(1),
      distance_m: distanceAlongLine,
      distance_km: distanceAlongLine.divide(1000),
      longitude: x,
      latitude: y
    });
  }));
}

function getProfileDefinition(result, selectedMode) {
  if (selectedMode === 'Export raster values') {
    return {
      image: result.output.rename('OutputCost').float(),
      bandNames: ['OutputCost'],
      title: 'Export raster cost values',
      yAxis: 'Export raster value',
      tag: 'output'
    };
  }

  var images = [result.cappedCost.rename('FinalCost')];
  var bandNames = ['FinalCost'];

  if (selectedMode === 'Combined cost + used factors') {
    var factorDefinitions = [
      {key: 'slope', name: 'SlopeMultiplier', image: result.layers.slope},
      {key: 'noWater', name: 'LackOfWaterMultiplier', image: result.layers.noWater},
      {key: 'waterAttraction', name: 'WaterAttractionMultiplier', image: result.layers.waterAttraction},
      {key: 'surfaceWater', name: 'SurfaceWaterMultiplier', image: result.layers.surfaceWater},
      {key: 'snow', name: 'SnowMultiplier', image: result.layers.snow},
      {key: 'looseSand', name: 'LooseSandMultiplier', image: result.layers.looseSand},
      {key: 'cold', name: 'ColdMultiplier', image: result.layers.cold},
      {key: 'height', name: 'AltitudeMultiplier', image: result.layers.height},
      {key: 'reservoirs', name: 'ReservoirReplacement', image: result.layers.reservoirs},
      {key: 'sea', name: 'SeaCost', image: result.layers.sea}
    ];
    var i;
    for (i = 0; i < factorDefinitions.length; i++) {
      var definition = factorDefinitions[i];
      if (result.settings.factors[definition.key].use && definition.image) {
        images.push(definition.image.rename(definition.name));
        bandNames.push(definition.name);
      }
    }
  }

  return {
    image: ee.Image.cat(images).float(),
    bandNames: bandNames,
    title: selectedMode,
    yAxis: bandNames.length === 1 ? 'Combined cost' : 'Cost / multiplier value',
    tag: bandNames.length === 1 ? 'combined' : 'combined_factors'
  };
}

function generateCostProfile() {
  var profileRun = ++profileState.runId;
  generateProfileButton.setDisabled(true);
  setProfileStatus('Preparing profile points and chart…', 'working');

  try {
    if (!appState.result) {
      throw new Error('Calculate a cost surface before generating a profile.');
    }
    var result = appState.result;
    var line = getProfileLine();
    var nPoints = Math.round(profilePointSlider.getValue());
    var scaleText = String(profileScaleBox.getValue() || '').trim();
    var samplingScale = Number(scaleText);
    if (scaleText === '' || !isFinite(samplingScale) || samplingScale <= 0) {
      throw new Error('Sampling scale must be a number greater than zero.');
    }

    var selectedMode = profileModeSelect.getValue();
    var profileDefinition = getProfileDefinition(result, selectedMode);
    var periodName = result.settings.period.name;
    var pointProperties = [
      'point_id', 'distance_m', 'distance_km', 'longitude', 'latitude',
      'period', 'profile_source', 'sampling_scale_m'
    ];
    var profilePoints = makePointsAlongLine(line, nPoints).map(function(feature) {
      return feature.set({
        period: periodName,
        profile_source: selectedMode,
        sampling_scale_m: samplingScale
      });
    });

    var sampledValues = profileDefinition.image.sampleRegions({
      collection: profilePoints,
      properties: pointProperties,
      scale: samplingScale,
      projection: result.projection,
      tileScale: 4,
      geometries: true
    }).sort('distance_m');

    profileState.samples = sampledValues;
    profileState.bandNames = profileDefinition.bandNames.slice();
    profileState.selectors = pointProperties.concat(profileState.bandNames);
    profileState.sourceLabel = selectedMode;
    profileState.requestedPoints = nPoints;
    profileState.periodName = periodName;
    profileState.sourceTag = profileDefinition.tag;
    profileState.samplingScale = samplingScale;

    removeMapLayersNamed('PROFILE sample points');
    appMap.addLayer(
      profilePoints,
      {color: 'ffff00'},
      'PROFILE sample points',
      true
    );

    var chart = ui.Chart.feature.byFeature({
      features: sampledValues,
      xProperty: 'distance_km',
      yProperties: profileDefinition.bandNames
    })
      .setChartType('LineChart')
      .setOptions({
        title: profileDefinition.title + ' – ' + periodName,
        hAxis: {title: 'Distance along line (km)'},
        vAxis: {title: profileDefinition.yAxis},
        lineWidth: 2,
        pointSize: 2,
        interpolateNulls: false,
        legend: {
          position: profileDefinition.bandNames.length === 1 ? 'none' : 'bottom'
        }
      });
    chart.style().set({height: '300px', stretch: 'horizontal'});
    profileChartPanel.clear();
    profileChartPanel.add(chart);
    profileChartPanel.style().set('shown', true);

    print('Cost-profile sampled values', sampledValues);
    print('Cost-profile band names', profileDefinition.bandNames);

    profileCsvButton.setDisabled(false);
    sampledValues.size().evaluate(function(count, error) {
      if (profileRun !== profileState.runId) return;
      generateProfileButton.setDisabled(false);
      if (error) {
        profileCsvButton.setDisabled(true);
        setProfileStatus(
          'Earth Engine could not sample the profile: ' + (error.message || error),
          'error'
        );
      } else if (count === 0) {
        profileCsvButton.setDisabled(true);
        setProfileStatus(
          'No raster values were returned. Keep the line inside the calculated analysis area.',
          'error'
        );
      } else {
        var omitted = nPoints - count;
        var omissionText = omitted > 0 ?
          ' ' + omitted + ' requested point(s) intersected masked or out-of-area cells.' : '';
        setProfileStatus(
          'Profile generated from ' + count + ' sampled point(s).' + omissionText +
          ' The graph is shown above and the table is in the Console.',
          'success'
        );
      }
    });
  } catch (error) {
    generateProfileButton.setDisabled(false);
    setProfileStatus('Profile error: ' + error.message, 'error');
  }
}

function createProfileCsvTask() {
  try {
    if (!profileState.samples || !profileState.selectors) {
      throw new Error('Generate a profile before creating its CSV export.');
    }
    var description = (
      'cost_profile_' + profileState.periodName + '_' + profileState.sourceTag + '_' +
      profileState.requestedPoints + 'pts'
    ).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
    var folder = readText('exportFolder', 'Google Drive folder', false);
    var exportParameters = {
      collection: profileState.samples,
      description: description,
      fileNamePrefix: description,
      fileFormat: 'CSV',
      selectors: profileState.selectors
    };
    if (folder !== '') exportParameters.folder = folder;

    Export.table.toDrive(exportParameters);
    print('Profile CSV export task: ' + description, {
      period: profileState.periodName,
      profile_source: profileState.sourceLabel,
      requested_points: profileState.requestedPoints,
      sampling_scale_m: profileState.samplingScale,
      folder: folder === '' ? '(Drive root)' : folder
    });
    setProfileStatus(
      'Profile CSV task "' + description + '" created. Open the Tasks tab and click RUN.',
      'success'
    );
  } catch (error) {
    setProfileStatus('Profile export error: ' + error.message, 'error');
  }
}


// -----------------------------------------------------------------------------
// 8. USER ACTIONS
// -----------------------------------------------------------------------------

function calculateAndDisplay() {
  var currentRun = ++appState.runId;
  calculateButton.setDisabled(true);
  drawingTools.stop();
  drawingTools.setDrawModes(['polygon', 'rectangle']);
  drawingTools.setSelected(null);
  setProfileControlsEnabled(false);
  invalidateProfileResults('Recalculating the surface; existing profile results were cleared.');
  setStatus('Building the Earth Engine calculation and map layers…', 'working');

  try {
    var settings = readModelSettings();
    var geometry = getAnalysisArea();
    var result = buildModel(settings, geometry);
    appState.result = result;
    renderResult(result);

    if (settings.printSettings) {
      print('M2PRM GUI settings (' + settings.period.name + ')', settings);
      print('Final cost image', result.output);
    }

    // A lightweight asynchronous request catches inaccessible/missing assets
    // without blocking the user interface with getInfo().
    result.output.bandNames().evaluate(function(bands, error) {
      if (currentRun !== appState.runId) return;
      calculateButton.setDisabled(false);
      if (error) {
        appState.result = null;
        setProfileControlsEnabled(false);
        setProfileStatus('Calculate a valid surface before profiling.', 'error');
        setStatus(
          'Earth Engine could not prepare the surface. Check asset access and the Console error: ' +
          (error.message || error),
          'error'
        );
      } else {
        setProfileControlsEnabled(true);
        setProfileStatus(
          'Surface ready. Draw or edit a profile line, then generate the graph.',
          'ready'
        );
        setStatus(
          'Cost surface prepared for ' + settings.period.name + '. ' +
          'Rendering may take time for a large area; use the Layers control to inspect factors.',
          'success'
        );
      }
    });
  } catch (error) {
    calculateButton.setDisabled(false);
    appState.result = null;
    setProfileControlsEnabled(false);
    setProfileStatus('Calculate a valid surface before profiling.', 'error');
    setStatus('Settings error: ' + error.message, 'error');
  }
}

function createDriveExportTask() {
  try {
    if (appState.nativeScale === null) {
      throw new Error('The native DSM resolution is still loading.');
    }
    setStatus('Preparing the current model for export…', 'working');

    var settings = readModelSettings();
    var geometry = getAnalysisArea();
    var requestedResolution = readNumber(
      'outputResolution', 'Requested output resolution', 0.000001, null, false
    );
    var outputResolution = requestedResolution <= appState.nativeScale ?
      appState.nativeScale : requestedResolution;

    // Rebuild from the current controls so changed parameters and edited AOI are
    // always reflected, even if Calculate was not pressed again.
    var result = buildModel(settings, geometry);
    appState.result = result;

    var prefix = readText('exportPrefix', 'Export name prefix', true);
    var description = (prefix + settings.period.name + '_' +
      Math.round(outputResolution) + 'm')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 100);
    var folder = readText('exportFolder', 'Google Drive folder', false);

    var exportParameters = {
      image: result.output,
      description: description,
      scale: outputResolution,
      maxPixels: 9e12,
      region: geometry
    };
    if (folder !== '') exportParameters.folder = folder;

    Export.image.toDrive(exportParameters);
    if (settings.printSettings) {
      print('Drive export task: ' + description, {
        resolution_m: outputResolution,
        folder: folder === '' ? '(Drive root)' : folder,
        settings: settings
      });
    }
    setStatus(
      'Drive export task "' + description + '" created at ' +
      outputResolution.toFixed(4) + ' m. Open the Tasks tab and click RUN.',
      'success'
    );
  } catch (error) {
    setStatus('Export error: ' + error.message, 'error');
  }
}

function restoreDefaults() {
  var i;
  for (i = 0; i < resetRegistry.length; i++) {
    // Output resolution has a dynamic native default and is handled below.
    if (resetRegistry[i].widget !== controls.outputResolution) {
      resetRegistry[i].widget.setValue(resetRegistry[i].value);
    }
  }
  if (appState.nativeScale !== null) {
    controls.outputResolution.setValue(String(appState.nativeScale));
  } else {
    controls.outputResolution.setValue('');
  }
  floatOptionsPanel.style().set('shown', true);
  appState.result = null;
  profileModeSelect.setValue('Capped combined cost (model units)');
  profilePointSlider.setValue(100);
  profileScaleBox.setValue(
    appState.nativeScale === null ? '' : String(appState.nativeScale)
  );
  clearProfileLine();
  setProfileControlsEnabled(false);
  setProfileStatus('Calculate a cost surface to activate the profile tools.', 'ready');
  setStatus('All model and display controls restored to the established defaults.', 'ready');
}


// -----------------------------------------------------------------------------
// 9. INITIALISE NATIVE RESOLUTION AND LAYOUT
// -----------------------------------------------------------------------------

function initialiseNativeResolution() {
  var collection = ee.ImageCollection('JAXA/ALOS/AW3D30/V4_1')
    .filterBounds(DEFAULT_GEOMETRY)
    .select('DSM');
  var projection = collection.first().select(0).projection();
  projection.nominalScale().evaluate(function(scale, error) {
    if (error) {
      nativeScaleLabel.setValue('Could not read the native AW3D resolution. Check the Console.');
      setStatus('Initialisation error: ' + (error.message || error), 'error');
      return;
    }
    appState.nativeScale = Math.round(scale * 10000) / 10000;
    controls.outputResolution.setValue(String(appState.nativeScale));
    profileScaleBox.setValue(String(appState.nativeScale));
    nativeScaleLabel.setValue(
      'Native AW3D resolution: ' + appState.nativeScale.toFixed(4) + ' m.'
    );
    exportButton.setDisabled(false);
    setStatus('Review the controls and calculate the cost surface.', 'ready');
  });
}

ui.root.widgets().reset([
  ui.SplitPanel({
    firstPanel: sidebar,
    secondPanel: appMap,
    orientation: 'horizontal',
    wipe: false,
    style: {stretch: 'both'}
  })
]);

initialiseNativeResolution();
