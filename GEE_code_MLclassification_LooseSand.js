// Define a central point in your study area (as X,Y WGS84 decimal degrees) and a scale,
// just for visualisation purposes. Change the coordinates to center the map in your own area
Map.setCenter(72.0428, 28.8447, 9);

// Define your area of interest
var geometry = /* color: #ffffff */ee.Geometry.Polygon(
        [[[26.034856936314327,31.965400777310872],
        [70.85299048338345,19.854238685800006],
        [111.41637223792247,21.349486823942993],
        [111.44459000218353,47.17893659653418],
        [70.6364691148242,53.122300330081565],
        [25.974978246994738,47.85290888472198],
        [26.034856936314327,31.965400777310872]]]);

print('Study area', geometry.area().divide(1000 * 1000), 'km2'); // AOI area km2 for info

// Indicate here iteration number and comments for naming the results
var iteration = 'it03';

// ////////////////////// IMPORT & COMPOSITE SENTINEL 1 COLLECTION ////////////////////////

// Load the Sentinel-1 ImageCollection
var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(geometry)
  .filterDate('2014-10-03', '2020-06-05');
  
// Print total Sentinel 1 images employed
print('Sentinel 1 images:', s1);

// Filter to get images from different look angles
var asc = s1.filter(ee.Filter.eq('orbitProperties_pass', 'ASCENDING'));
var desc = s1.filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'));
var vvvhAsc = asc
  // Filter to get images with VV and VH single polarization
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
  // Filter to get images collected in interferometric wide swath mode.
  .filter(ee.Filter.eq('instrumentMode', 'IW'));
var vvvhDesc = desc
  // Filter to get images with VV and VH dual polarization
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
  // Filter to get images collected in interferometric wide swath mode.
  .filter(ee.Filter.eq('instrumentMode', 'IW'));
  
// Create a composite from means at different polarizations and look angles.
var composite = ee.Image.cat([
  vvvhAsc.select('VV').median(),
  vvvhAsc.select('VH').median(),
  vvvhDesc.select('VV').median(),
  vvvhDesc.select('VH').median(),
]).clip(geometry);

// Rename the bands so you can identify them when they are all joined together
var s1comp = composite.select(
    ['VV','VH','VV_1','VH_1'], // old names
    ['s1vva','s1vha','s1vvd','s1vhd'] // new names
);


// ////////////////////// IMPORT & COMPOSITE SENTINEL 2 COLLECTION ////////////////////////

// Function to mask clouds using the Sentinel-2 QA band.
function maskS2clouds(image) {
  var qa = image.select('QA60');

  // Bits 10 and 11 are clouds and cirrus, respectively.
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;

  // Both flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0).and(
             qa.bitwiseAnd(cirrusBitMask).eq(0));

  // Return the masked and scaled data, without the QA bands.
  return image.updateMask(mask).divide(10000)
      .select("B.*")
      .copyProperties(image, ["system:time_start"]);
}

// Map the function over one year of data and take the median.
// Load Sentinel-2 TOA reflectance data.
var S2_col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geometry)
    .filterDate('2015-06-23', '2020-06-05')
    // Pre-filter to get less cloudy granules.
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .map(maskS2clouds);

// Print total Sentinel 2 images employed
print('Sentinel 2 images', S2_col);

// Select the bands of interest form the Image Collection
var s2comp = S2_col.select(['B2','B3','B4','B5','B6','B7','B8','B8A','B11','B12'])
  .mean().clip(geometry);


// ////////////////////// COMPOSITE SENTINEL 1 & 2 MEAN BANDS ////////////////////////

// Join the S1 and S2 composites in a single composite that will be used for the extraction
// of training data and the application of the trained classifier
var fullComposite = ee.Image([s1comp, s2comp]);

// Reduction in the number of decimal places of the values of the resulting raster
// This will not reduce noticeably the quality of the data but it will reduce significantly
// the size of the resulting raster.
var Composite = ee.Image(0).expression(
    'round(img * 10000) / 10000', {
      'img': fullComposite
    });
    
print('Composite:', Composite);


// ////////////////////// MACHINE LEARNING RF CLASSIFIER ////////////////////////

// Training data:
var desert = ee.FeatureCollection('projects/ee-hao23/assets/desert_SilkRoad'),
    noDesert = ee.FeatureCollection('projects/ee-hao23/assets/noDesert_SilkRoad');

// Merge training data
var trn_pols = desert.merge(noDesert);
print(trn_pols, 'train_pols');

// Create variable for bands
var bands = ['s1vva','s1vha','s1vvd','s1vhd','B2','B3','B4','B5','B6','B7','B8','B8A','B11','B12']; 

// SampleRegions to extract band values for each pixel in each training polygon
var training = Composite.select(bands).sampleRegions({
  collection: trn_pols,
  properties: ['class'],
  scale: 10
}); 

// Apply RF classifier calling mode "probability"
var classifier = ee.Classifier.smileRandomForest({'numberOfTrees':128})
  .setOutputMode('PROBABILITY').train({
  features: training,
  classProperty: 'class',
  inputProperties: bands
});

// Create classified probability raster
var classified = Composite.select(bands).classify(classifier).unmask(0);

// Add the resulting classified layer to the Map Window below
Map.addLayer(classified, {min: 0.55, max: 1}, iteration); // It can take several minutes to load


// ////////////////////// FILTER OF SMALL FALSE POSITIVES ////////////////////////

// Threshold of the percentage of the RF classification
var gt = 0.7; // Probablity value selected as threshold
var threshold = classified.select('classification').gt(gt);

// Median filter to eliminate isolated high probability pixels
var r = 1; // Radius (in pixels) selected for the kernel
var filtered = threshold.focal_median({
               kernel: ee.Kernel.square({radius: r, units: 'pixels'})
}).gt(0);

Map.addLayer(filtered,{},'filtered');

// ////////////////////// EXPORT OF RESULTING DATASETS ////////////////////////

// Data exports as assets so they can be included and visualises in next iterations
Export.image.toAsset({ // It is also possible to export to Google Drive, just select the option in the dialogue
  image: classified,
  description: 'rf128_S1-S2_prob_' + iteration,
  scale: 10,
  maxPixels: 1e12,
  region: geometry
});

// Export of the filtered raster
Export.image.toAsset({ // Also possible to export to Google Drive, select when dialogue appears
  image: filtered,
  description: 'sandDunes',
  scale: 30,
  maxPixels: 1e12,
  region: geometry
});
