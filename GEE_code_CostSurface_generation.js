// Define a central point in your study area (as X,Y WGS84 decimal degrees) and a scale,
// just for visualisation purposes
Map.setCenter(67.601,37.566,5);

var geometry = ee.Geometry.Polygon([            // Geographic coordinates defining the study area
    [26.034856936314327, 31.965400777310872],
    [34.19255939893447,27.520378920323584],
    [70.85299048338345, 19.854238685800006],
    [90.28374707240327,20.074324423110866],
    [112.29527848792249,21.22664649657822],
    [112.23560562718355,47.3578548447329],
    [70.6364691148242, 53.122300330081565],
    [25.974978246994738, 47.85290888472198],
    [26.034856936314327,31.965400777310872]]);


////////////DIGITAL SURFACE MODEL (DSM)///////////////

var aw3d = ee.ImageCollection('JAXA/ALOS/AW3D30/V4_1')
    .filterBounds(geometry);

var elevation = aw3d.select('DSM');

var proj = elevation.first().select(0).projection();

var dsm = elevation
    .mosaic()
    .setDefaultProjection(proj)
    .clip(geometry);


///////////TEMPORAL PARAMETERS/////////////////

// Seasonal parameters for the filter of data collections
var yr = ee.Filter.dayOfYear(1,364), jan = ee.Filter.dayOfYear(1,31), feb = ee.Filter.dayOfYear(32,59), mar = ee.Filter.dayOfYear(60,90), apr = ee.Filter.dayOfYear(91,120), may = ee.Filter.dayOfYear(121,151), jun = ee.Filter.dayOfYear(152,181), jul = ee.Filter.dayOfYear(182,212), aug = ee.Filter.dayOfYear(213,243), sep = ee.Filter.dayOfYear(244,273), oct = ee.Filter.dayOfYear(274,304), nov = ee.Filter.dayOfYear(305,334), dec = ee.Filter.dayOfYear(335,365); 

var periodSel = prompt('Select yr for the whole year or month of travel: jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec', 'yr'); // Chose a period from the list of variables above

if (periodSel == 'yr') {var period = yr, periodName = 'yr'}
if (periodSel == 'jan') {var period = jan, monthNum = '00', altNum = '01', periodName = 'jan'}
if (periodSel == 'feb') {var period = feb, monthNum = '01', altNum = '02', periodName = 'feb'}
if (periodSel == 'mar') {var period = mar, monthNum = '02', altNum = '03', periodName = 'mar'}
if (periodSel == 'apr') {var period = apr, monthNum = '03', altNum = '04', periodName = 'apr'}
if (periodSel == 'may') {var period = may, monthNum = '04', altNum = '05', periodName = 'may'}
if (periodSel == 'jun') {var period = jun, monthNum = '05', altNum = '06', periodName = 'jun'}
if (periodSel == 'jul') {var period = jul, monthNum = '06', altNum = '07', periodName = 'jul'}
if (periodSel == 'aug') {var period = aug, monthNum = '07', altNum = '08', periodName = 'aug'}
if (periodSel == 'sep') {var period = sep, monthNum = '08', altNum = '09', periodName = 'sep'}
if (periodSel == 'oct') {var period = oct, monthNum = '09', altNum = '10', periodName = 'oct'}
if (periodSel == 'nov') {var period = nov, monthNum = '10', altNum = '11', periodName = 'nov'}
if (periodSel == 'dec') {var period = dec, monthNum = '11', altNum = '12', periodName = 'dec'}


///////////MAXIMUM COST VALUE/////////////

// Assign a maximum cost value
var maxCostPrompt = prompt('Value for the maximum cost', 40); // From this value upwards all values will be considered the same maximum cost. This aims to reduce the model's cost by normalising it and scaling it at a later stage
var maxCost = Math.round(maxCostPrompt);


///////////SLOPE/////////////

// Creating a slope map in degrees
// GEE recommends to "Reproject an image mosaic using a projection from one of the image tiles rather than using the default projection returned by .mosaic()". 
// Unlike most DSMs in GEE, which are single images, the last version of the ALOS DSM is an Image Collection and presents multiple resolutions
var slope = ee.Terrain.slope(dsm);

// Transform slope in mathematical degrees
var slp_rad = slope.multiply(3.1415926536)
    .divide(180);
var slp_dg = slp_rad.tan();

// Add slope costs for humans using the sixth degree polynomial developed by Herzog (CAA 2010) 'Theory and Practice of Cost Functions' from ethnographic data by Minetti et al. (2002)
var costSlp1 = ((slp_dg.pow(6)).multiply(1337.8))
    .add((slp_dg.pow(5)).multiply(278.19))
    .subtract((slp_dg.pow(4)).multiply(517.39))
    .subtract((slp_dg.pow(3)).multiply(78.199))
    .add((slp_dg.pow(2)).multiply(93.419))
    .add((slp_dg.multiply(19.825)))
    .add(1.64);
var costSlp2 = costSlp1.select(['slope'],['cost']);
// Set maximum value to 99.99 (to avoid large raster size)
var costSlp = (costSlp2.gt(99.99).multiply(99.99))
    .add(costSlp2.lte(99.99).multiply(costSlp2));


/////////////SNOW////////////

var snowBase = ee.ImageCollection('MODIS/061/MOD10A1').select('NDSI_Snow_Cover')
    .filter(period)
    .filterBounds(geometry)
    .reduce(ee.Reducer.mean())
    .unmask(0)
    .clip(geometry);

var snow = snowBase.divide(33.33).add(ee.Image(1)); // This provides a maximum value of around 4 (original max. value is 100, which has been divided by 33.33 and added 1) for the study area, in line with suggested values for Pandolf et al. 1977 (in Herzog Int.Arch., 36,5)


//////////////SEA////////////

// Add a sea mask layer
var mskALOS = aw3d
    .select('MSK')
    .mosaic()
    .clip(geometry)
    .setDefaultProjection(proj);

var alosSea = mskALOS // In the AW3D MSK band, cells classified as sea have a value of 3
    .bitwiseAnd(3)
    .eq(3)
    .unmask(0)
    .toByte()
    .rename('allSeas');

// Additional Caspian Sea mask. AW3D30 V4.1 disables the Caspian sea mask, so it has been added independently
var caspianRegion = ee.Geometry.Rectangle([46.0, 36.0, 55.2, 47.8], null, false); // A rectangle with the approximate area

var caspianSea = ee.Image('JRC/GSW1_4/GlobalSurfaceWater') // JRC water mask restricted to the Caspian region
    .select('occurrence')
    .clip(caspianRegion)
    .unmask(0)
    .gte(90) // water present in at least 90% of valid observations
    .toByte()
    .rename('allSeas');

// Combined mask for all seas. AW3D masks ordinary seas/oceans and JRC adds the Caspian Sea.
var allSeas = ee.ImageCollection([alosSea, caspianSea]).mosaic();

// Reclassify sea cells to the model's maximum cost
var seaMsk = allSeas
    .multiply(maxCost)
    .float();


//////////////ELIMINATE RESERVOIRS////////////

var maskDams = ee.FeatureCollection('users/hao23/Grand_reservoirs') // Global Reservoir and Dam Database (GRanD) v1.3 (2019), by the Global Dam Watch (Lehner, B., C. Reidy Liermann, C. Revenga, C. Vörösmarty, B. Fekete, P. Crouzet, P. Döll, M. Endejan, K. Frenken, J. Magome, C. Nilsson, J.C. Robertson, R. Rodel, N. Sindorf, and D. Wisser. 2011. High-resolution mapping of the world’s reservoirs and dams for sustainable river-flow management. Frontiers in Ecology and the Environment 9 (9): 494-502)
    .reduceToImage({                                                // Download from https://www.globaldamwatch.org/directory and upload into your own assets, then substitute the name of the asset
        properties: ['value'],
        reducer: ee.Reducer.first()})
    .unmask(0)
    .remap([0,1],[1,0])
    .clip(geometry);

var dams = maskDams.remap([0,1],[3.28,0]).float(); // It is considered that 3.28, double the minimum cost value, should be appropriate for areas in which a reservoir is currently present


/////////COLD////////////

// Select a range of surface temperatures to measure the importance of cold
var tempMinCold = -13; // Minimum value (in °C) for the monthly average surface temperature (the minimum would correspond to night times)
var tempMaxCold = 5; // Maximum value (in °C) for the monthly average of average surface temperature

var windSpeed = ee.ImageCollection('IDAHO_EPSCOR/TERRACLIMATE').select('vs')
    .filter(period)
    .filterBounds(geometry)
    .reduce(ee.Reducer.mean())
    .unmask(0)
    .multiply(0.036) // This multiplication includes the scale factor for this band (0.01) and the multiplication to pass from m/s to Km/h (3.6)
    .clip(geometry);

// Daytime temperature proxy:
// intermediate between the 24-hour monthly mean and the monthly average daily maximum

if (periodSel == 'yr') {

    var tempBands = ee.ImageCollection('WORLDCLIM/V1/MONTHLY')
        .select(['tavg', 'tmax'])
        .mean()
        .multiply(0.1); // WorldClim temperatures are stored as °C * 10

    var temp = tempBands.select('tavg')
        .add(tempBands.select('tmax'))
        .divide(2)
        .rename('tday_proxy');
}

else {

    var tempBands = ee.Image('WORLDCLIM/V1/MONTHLY/' + altNum)
        .select(['tavg', 'tmax'])
        .multiply(0.1); // WorldClim temperatures are stored as °C * 10

    var temp = tempBands.select('tavg')
        .add(tempBands.select('tmax'))
        .divide(2)
        .rename('tday_proxy');
}

// Wind chill has different formulae but this seems the most updated: WC = 13.12 + 0.6215T – 11.37V^0.16 + 0.3965TV^0.16   more info: https://www.calculator.net/wind-chill-calculator.html
// The index is defined for temperature at or below 10℃ (50F) and wind speed above 4.8km/h (3mph).
var wcValues = ee.Image(13.12)
    .add(ee.Image(0.6215).multiply(temp))
    .subtract(ee.Image(11.37).multiply(windSpeed.pow(0.16)))
    .add(ee.Image(0.3965).multiply(temp).multiply(windSpeed.pow(0.16)));

var windChill = ((temp.lte(10).and(windSpeed.gte(4.8))).multiply(wcValues))
    .add((temp.gt(10).or(windSpeed.lt(4.8))).multiply(temp));

var cold1 = windChill.gte(tempMinCold);
var cold2 = windChill.lte(tempMaxCold);
var cold3 = (windChill.lt(tempMinCold)).multiply(tempMinCold);
var cold4 = (windChill.gt(tempMaxCold)).multiply(tempMaxCold);
var cold5 = ((cold1.multiply(cold2)).multiply(windChill)).add(cold3).add(cold4);
var cold = ee.Image(2).subtract(((cold5.subtract(tempMinCold)).divide(tempMaxCold-tempMinCold))); // values from 1 to 2


/////////LOOSE SAND OR DUNES////////////

// The variable below calls a raster layer of loose sand/dunes for the study area obtained from a machine learning classification of
// multisource multitemporal Sentinel 1 and 2 data
var sandProb = ee.Image('users/hao23/looseSand_SA').unmask(0).clip(geometry); // Use 'users/hao23/looseSand_RE' for the Roman Empire area

var looseSand = ee.Image(1)
  .add(sandProb.gte(0.7).multiply(sandProb.multiply(0.9)));


/////////LACK OF WATER////////////

// Select a range of surface temperatures to measure the importance of desert conditions
var tempMin = 26; // Minimum value (in °C) for the monthly average of maximum air temperature from which aridity will add to the cost of movement
var tempMax = 38; // Maxiumu value (in °C) for the monthly average of maximum air temperature.

var heat1 = temp.gte(tempMin); // Values equal or above tempMin = 1, all other values = 0
var heat2 = temp.lte(tempMax); // Values equal or below temMax = 1, all other values = 0
var heat3 = (temp.lt(tempMin)).multiply(tempMin); // Values lower or equal than tempMin = tempMin
var heat4 = (temp.gt(tempMax)).multiply(tempMax); // Values greater or equal than tempMax = tempMax
var heat5 = ((heat1.multiply(heat2)).multiply(temp)).add(heat3).add(heat4); // Creates a raster where evi values equal or below tempMin = tempMin and all values equal or above tempMax = tempMax. values between them = temp values
var heat = ((heat5.subtract(tempMin)).divide(tempMax-tempMin)).multiply(2); // Values from 0 (<= 26°C) to 2 (>= 40°C)

// Obtain the multitemporal Enhanced Vegetation Index (EVI).
// After several proofs this seems to be a better indicator for water presence/absence than NDWI. The mean yearly value makes sure that seasonal cultivation values fall below 0.2
// The selection of years reduces the impact of large irrigation schemes in most of the study area
if (periodSel == 'yr') {
  var evi = ee.ImageCollection('LANDSAT/COMPOSITES/C02/T1_L2_8DAY_EVI')
    .filterDate('1984-01-01', '1995-12-31')
    .filter(period)
    .filterBounds(geometry)
    .reduce(ee.Reducer.mean())
    .unmask(0)
    .clip(geometry);
}
else {
  var evi = ee.ImageCollection('LANDSAT/COMPOSITES/C02/T1_L2_8DAY_EVI') // As there are not enough single month images to comprehensively cover the study area the temporal period has been extended until 2015 for single month queries
    .filterDate('1984-01-01', '2015-12-31')
    .filter(period)
    .filterBounds(geometry)
    .reduce(ee.Reducer.mean())
    .unmask(0)
    .clip(geometry);
}

// Select desert areas and give them a high cost. The values are selected for the layer to be used as a multiplier with maximum values of 4, which, in practical terms, is reduced to around 2 (double cost)
var dsrtThrs = 0.075; // The desert threshold 'dsrtThrs' is the EVI value designated as the threshold in which desert conditions (lack of water and vegetation, healthy vegetation values range from 0.2 to 0.8) start to increase the cost of movement

var desert1 = evi.gte(0);
var desert2 = evi.lte(dsrtThrs);
var desert3 = evi.lt(0);
var desert4 = evi.gt(dsrtThrs).multiply(dsrtThrs);
var desert5 = ((desert1.multiply(desert2)).multiply(evi)).add(desert4);
var desert6 = (desert5.divide(dsrtThrs)).add(1); // Values from 1 to 2, when divided to the base cost raster, the lowest values (very arid) do not change the cost and the higher ones (less arid) double it
var desert = ((desert6.subtract(3)).multiply(-1)).subtract(desert3); // Values 1-2. Negative values in EVI can reflect water. For this reason the raster has been reclassified to reflect negatives values as 1

// Create a cost multiplier that will cost the lack of water according to desert conditions that will only be added is temperature is above 26 °C (monthly max average) and will increase with temperature and aridity increase.
var noWat = desert.pow(heat);


////////////WATER ATTRACTION//////////

// Factoring attraction to areas with more presence of water that is only implemented in areas with high aridity and temperature but also isolated as water can be carried by humans and animals
var queryConv = prompt('Do you want to use the water attraction factor (much more costly as it requires the use of convolutions, use for national rather than continental areas)   y/n', 'n');
// Create a convolution with a radius to provide a sense of distance for the areas where desert and temperature are high and, therefore, the presence of water can be consider an attracting factor
if (queryConv == 'y') { 
  var rWat = 7.5; // Radius (in kms) selected for the kernel
  var watConv = noWat
      .gt(1)
      .focal_median({
                kernel: ee.Kernel.circle({radius: (rWat*1000), units: 'meters'})
      });

// Select the areas with water presence and reduce their cost using the resulting raster as a divider. EVI healthy vegetation values range from 0.20 to 0.80
var waterThrs = 0.2; // The water threshold 'waterThrs' is the EVI value designated as the threshold from which water availability (as reflected by the presence of healthy vegetation) starts reducing the cost of movement
var watAtt = watConv.multiply(evi.gte(waterThrs)).remap([0,1],[1,0.75]); // To make sure that the presence of water will reduce travel costs only in the areas where temperatures are high
}
else {var watAtt = ee.Image(1)}


////////////SURFACE WATER//////////

// Surface water raster
if (periodSel == 'yr') {var watRecur = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('occurrence').unmask(0); 
    var surfWat = watRecur.divide(33.33).add(ee.Image(1)).clip(geometry); // Values from 1 to 4 (original max. value is 100, which has been divided by 33.3 and added 1) as many areas are partially watered during the months but if there is constant water the cost to pass through should very high
} 
else {var watRecur = ee.Image('JRC/GSW1_4/MonthlyRecurrence/monthly_recurrence_'+ monthNum).select("monthly_recurrence").unmask(0); 
    var surfWat = watRecur.divide(33.33).add(ee.Image(1)).clip(geometry);
}


///////////////HEIGHT/////////////////////

// Height above 2000 m.a.s.l. using a purposely developed non-linear exponential equation for proportional rate growth to fit the curve to the three points (2000,1; 5050,1.24; 5600,1.39):
// cost = 0.9829854 - (-0.000003334709/-0.0008254486)*(1 - e^(0.0008254486*height))
// This function derives a curve intersecting the two values for which we have data on how altitude affects performance (from Herzog Int.Arch, 36-5):
// “The European Commission (European Commission, 1995–2010 Travel Time to Major Cities: A global map of Accessibility. http://bioval.jrc.ec.europa.eu/products/gam/index.htm) assumes that there is no negative effect on walking speed below an altitude of 2000m” … "Minetti et al. (Minetti, A.E., Formenti, F. and Ardigò, L.P. 2006 'Himalayan porter's specialization: metabolic power, economy, efficiency and skill', Proceedings of the Royal Society on Biological Sciences, 273: 2791–7. http://dx.doi.org/10.1098/rspb.2006.3653) refer to a study which found that the maximum metabolic power decreases at high altitude, i.e. at 5600m asl, the maximum metabolic power of a Caucasian is only 61% of that measured at sea-level. So the values given by the (corrected) formula used by the European Commission seem to exaggerate the effects of high altitudes. In the experiments of the Minetti research group, both Nepalese porters and Caucasians experienced a drop of 24% of the maximum metabolic power at an altitude of 5050m asl" 

var height = (ee.Image(-0.0170146).subtract(ee.Image(0.004039874802622).multiply(ee.Image(1).subtract(ee.Image(2.718281828459).pow(dsm.multiply(ee.Image(0.0008254486)))))))
    .multiply(dsm.gt(2000))
    .add(ee.Image(1));


/////////////COST RASTER CREATION/////////////////

var costsRaw = costSlp
    .multiply(noWat)
    .multiply(watAtt)
    .multiply(surfWat)
    .multiply(snow)
    .multiply(looseSand)
    .multiply(cold)
    .multiply(height)
    .multiply(maskDams).add(dams)
    .add(seaMsk);


///////////////SCALING AND NORMALISATION//////////////////

// This is necessary to reduce the very high computational costs a floating raster will have in the calculation of the cost accumulation raster. From the current floating point raster we will develop an unsigned 8 bit raster.
// This will be done in two steps:
//   1. The maximum cost value that will substitute all values larger than it. This is done so the scaling will not have to incorporate the maximum values of the floating raster and, in doing so reduce the resolution of the lower values that are the most significant in terms of movement.
//   2. 8-bit scaling for low memory settings and small rasters / or float scaling for memory efficient use in GRASS r.cost

// Substitute all values higher than the maximum cost value
var costsMax = (costsRaw.gt(maxCost).multiply(maxCost))
    .add(costsRaw.lte(maxCost).multiply(costsRaw));

var bitSel = prompt('Select 8-bit or floating-point raster output', 'Float');

if (bitSel == '8-bit') {var costs = (costsMax.divide(maxCost)).multiply(255).byte().clip(geometry).unmask(255); // 8-bit scaling of values
    Map.addLayer(costs, {min:1, max:150, palette: '0f00ff, 03ff00, efff00, ffbc00, ff0000, ff0081'}, 'Cost surface');
} 
else {var costs = costsMax.multiply(ee.Number(10).pow(4)).round().divide(ee.Number(10).pow(4)).multiply(0.0001).clip(geometry).unmask(0.004); // Floating-point scaling of values
    Map.addLayer(costs, {min:0.0001, max:0.001, palette: '0f00ff, 03ff00, efff00, ffbc00, ff0000, ff0081'}, 'Cost surface');
}


////////////////EXPORT MAP///////////////////

var rr = Math.round((proj.nominalScale().getInfo())*10000) / 10000;
var outrrPrmpt = prompt('Output raster resolution in m (defaults to the resolution of the DSM)', rr);

if (outrrPrmpt <= rr) {var outrr = rr;} else {var outrr = outrrPrmpt;}

Export.image.toDrive({
  image: costs,
  description: 'costsurf_SilkRoute_' + periodName + '_' + Math.round(outrr) + 'm',
  scale: outrr,
  maxPixels: 9e12,
  region: geometry
});
