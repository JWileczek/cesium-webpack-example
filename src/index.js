
import {
    CallbackProperty,
    Cartesian3,
    Cartographic,
    Cesium3DTileset, ClockRange,
    Color,
    createWorldTerrain,
    CustomDataSource,
    defined,
    DistanceDisplayCondition, EllipsoidGeodesic,
    Entity,
    IonResource,
    JulianDate,
    PathGraphics,
    PointGraphics, PolylineGraphics,
    PropertyBag,
    SampledPositionProperty,
    ScreenSpaceEventHandler, ScreenSpaceEventType,
    TimeInterval,
    TimeIntervalCollection,
    Viewer,
    Math as CesiumMath,
} from 'cesium';
import { sgp4, twoline2satrec, gstime, propagate, eciToGeodetic, eciToEcf } from 'satellite.js';
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./css/main.css";

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc);
dayjs.extend(timezone);

dayjs.tz.setDefault('America/New_York');

const csvData2 = require('./SatelliteData.csv');
const shipCSV = require('./AISData.csv');

var viewer = new Viewer('cesiumContainer', {
    selectionIndicator: false,
});


let coloredSats = [];
let hitSource = null;
let lastUpdateTime = null;
const satMap = { };
let minDate = null;
let maxDate = null;
const csvs = [csvData2];
for (const satData of csvs) {
    for (const csvRow of satData) {
        const d = dayjs(Number(csvRow.millis70), 'YYYY-MM-DD HH:mm:ss', 'America/New_York').toDate();
        if (minDate == null || d.getTime() < minDate) {
            minDate = d.getTime();
        }
        if (maxDate == null || d.getTime() > maxDate) {
            maxDate = d.getTime();
        }
        csvRow['dt'] = d;
        if (satMap.hasOwnProperty(csvRow['satellite'])) {
            const satObj = satMap[csvRow['satellite']];
            satObj.tles.push(csvRow);
        } else {
            satMap[csvRow['satellite']] = {
                satellite: csvRow.satellite,
                tles: [csvRow]
            };
        }
    }
}

const shipData = {};
for (const shipRow of shipCSV) {
    shipRow.time = dayjs(shipRow.basedatetime, 'YYYY-MM-DDTHH:mm:ss', 'America/New_York').toDate();
    shipRow.imo = shipRow.imo.replace('IMO', '');
    if (shipData.hasOwnProperty(shipRow.imo)) {
        const shipObj = shipData[shipRow.imo];
        shipObj.points.push(shipRow);
    } else {
        shipData[shipRow.imo] = {
            id: shipRow.imo,
            name: shipRow.vesselname,
            mmsi: shipRow.mmsi,
            callSign: shipRow.callsign,
            vesselType: shipRow.vesseltype,
            points: [],
        };
    }
}
let shipMinDate = null;
let shipMaxDate = null;
let shipSource = new CustomDataSource('ships');
let satelliteSource = new CustomDataSource('satellites');
for (const key of Object.keys(shipData)) {
    const ship = shipData[key];
    if (ship.points.length < 2 || ship.name === "" || ship.id === "") {
        //Ignore ships that don't have point data.
        continue;
    }
    ship.points = ship.points.sort((a,b) => a.time - b.time);
    const sMin = ship.points[0].time.getTime();
    const sMax = ship.points[ship.points.length - 1].time.getTime();
    if (shipMinDate == null || sMin < shipMinDate) {
        shipMinDate = sMin;
    }
    if (shipMaxDate == null || sMax > shipMaxDate) {
        shipMaxDate = sMax;
    }
    const shipSamplePoints = ship.points.map((point) => {
        return {
            position: Cartesian3.fromDegrees(Number(point.lon), Number(point.lat)),
            time: JulianDate.fromDate(point.time),
        };
    });
    const sampledPos = new SampledPositionProperty();
    for (const samplePoint of shipSamplePoints) {
        sampledPos.addSample(samplePoint.time, samplePoint.position );
    }
    const shipInterval = new TimeInterval({
        start: JulianDate.fromDate(dayjs(sMin, 'YYYY-MM-DDTHH:mm:ss', 'America/New_York').toDate()),
        stop: JulianDate.fromDate(dayjs(sMax, 'YYYY-MM-DDTHH:mm:ss', 'America/New_York').toDate()),
        isStartIncluded: true,
        isStopIncluded: true,
    });
    const shipAvailability = new TimeIntervalCollection([shipInterval]);
    const shipProps = new PropertyBag();
    shipProps.addProperty('mmsi', ship.mmsi);
    shipProps.addProperty('callSign', ship.callSign);
    shipProps.addProperty('vesselType', ship.vesselType);
    const shipEntity = new Entity({
        availability: shipAvailability,
        id: `${ship.name} (${ship.id})`,
        name:`${ship.name} (IMO: ${ship.id})`,
        position: sampledPos,
        point: new PointGraphics({
            color: Color.ALICEBLUE,
            pixelSize: 8,
        }),
        path: new PathGraphics({
            material: Color.BEIGE,
            width: 3,
            leadTime: 3600,
            trailTime: 3600,
            distanceDisplayCondition: new DistanceDisplayCondition(0.0, 900000 * 4),
        }),
        properties: shipProps,
    });
    shipSource.entities.add(shipEntity);
}
viewer.dataSources.add(shipSource);


viewer.scene.preUpdate.addEventListener((scene, currentTime) => {
    if (defined(viewer.selectedEntity) && (lastUpdateTime == null || Math.abs(JulianDate.secondsDifference(currentTime, lastUpdateTime)) > 1)) {
        if (shipSource.entities.contains(viewer.selectedEntity) && viewer.selectedEntity.isAvailable(currentTime)) {
            const shipPos = Cartographic.fromCartesian(viewer.selectedEntity.position.getValue(currentTime));
            colorSatellitesByDistance(shipPos, currentTime);

            resetShipColors();
            viewer.selectedEntity.point.color = Color.ORANGE;
            const satsInRange = collectInDistance(shipPos, currentTime, true);
            viewer.selectedEntity.description = buildShipDescription(viewer.selectedEntity, satsInRange);
            lastUpdateTime = currentTime;
        }

        if (satelliteSource.entities.contains(viewer.selectedEntity) && viewer.selectedEntity.isAvailable(currentTime)) {
            const satPos = Cartographic.fromCartesian(viewer.selectedEntity.position.getValue(currentTime));
            colorShipsByDistance(satPos, currentTime);

            resetSatColors();
            viewer.selectedEntity.point.color = Color.ORANGE;
            const shipsInRange = collectInDistance(satPos, currentTime, false);
            viewer.selectedEntity.description = buildSatelliteDescription(viewer.selectedEntity, shipsInRange, currentTime);
            if (viewer.selectedEntity.polyline == null || viewer.selectedEntity.polyline.positions == null) {
                viewer.selectedEntity.polyline = createOrbitGraphics(viewer.selectedEntity.properties.tleCollection.getValue(currentTime));
            }
            lastUpdateTime = currentTime;
        }
    }
});

const eventHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
eventHandler.setInputAction((event) => {
    const pick = viewer.scene.pick(event.position);

    if (!defined(pick) || !defined(pick.id)) {
        //TODO: Clicked a location not containing an entity.
        resetEntityColors();
    } else if (defined(pick) && defined(pick.id)) {
        const pickedEntity = pick.id;

        if (shipSource.entities.contains(pickedEntity) && pickedEntity.isAvailable(viewer.clock.currentTime)) {
            //TODO: Picked a ship entity, get it's position and run distance calculation.
            const currTime = viewer.clock.currentTime;
            const shipPos = Cartographic.fromCartesian(pickedEntity.position.getValue(currTime));
            colorSatellitesByDistance(shipPos, currTime);

            const satsInRange = collectInDistance(shipPos, currTime, true);
            viewer.selectedEntity.description = buildShipDescription(viewer.selectedEntity, satsInRange);

            resetShipColors();
            viewer.selectedEntity.point.color = Color.ORANGE;
        }

        //If the user selects a satellite stop/pause the simulation?
        if (satelliteSource.entities.contains(pickedEntity) && pickedEntity.isAvailable(viewer.clock.currentTime)) {
            //TODO: Reverse the problem, upon selecting satellite, get ships in range and color by if this satellite can see them.
            const currTime = viewer.clock.currentTime;
            const satPos = Cartographic.fromCartesian(pickedEntity.position.getValue(currTime));
            colorShipsByDistance(satPos, currTime);
            const shipsInRange = collectInDistance(satPos, currTime, false);
            viewer.selectedEntity.description = buildSatelliteDescription(viewer.selectedEntity, shipsInRange, currTime);
            resetSatColors();
            viewer.selectedEntity.point.color = Color.ORANGE;
            if (viewer.selectedEntity.polyline == null || viewer.selectedEntity.polyline.positions == null) {
                viewer.selectedEntity.polyline = createOrbitGraphics(viewer.selectedEntity.properties.tleCollection.getValue(currTime));
            }
        }
    } else {
        revertSatelliteColors();
    }
}, ScreenSpaceEventType.LEFT_CLICK)


const clock = viewer.clock;
clock.startTime = JulianDate.fromDate(dayjs(minDate, 'America/New_York').toDate());
clock.stopTime = JulianDate.fromDate(dayjs(maxDate, 'America/New_York').toDate());
clock.currentTime = JulianDate.fromDate(dayjs(shipMinDate, 'America/New_York').toDate());
clock.clockRange = ClockRange.LOOP_STOP;
for (const key of Object.keys(satMap)) {
    const satObj = satMap[key];
    satObj.tles = satObj.tles.sort((a, b) => a.dt - b.dt);


    const tInts = [];
    for (const [i, tle] of satObj.tles.entries()) {
        let nextTLE = null;
        if (i + 1 < satObj.tles.length - 1) {
            nextTLE = satObj.tles[i + 1];
        }

        if (tle && nextTLE) {
            const startRec = twoline2satrec(tle['tleline1'], tle['tleline2']);
            const endRec = twoline2satrec(nextTLE['tleline1'], nextTLE['tleline2']);
            const startTime = new JulianDate(startRec.jdsatepoch);
            const endTime = new JulianDate(endRec.jdsatepoch);

            const timeInt = new TimeInterval({
                start: startTime,
                stop: endTime,
                data: startRec,
                isStartIncluded: true,
                isStopIncluded: false,
            });
            tInts.push(timeInt);
        }
    }

    satObj.tleCollection = new TimeIntervalCollection(tInts);
    const propBag = new PropertyBag();
    propBag.addProperty("tleCollection", satObj.tleCollection);
    const tleProp = new CallbackProperty(function (time, result) {
        const satRec = this.tleCollection.findDataForIntervalContainingDate(time);
        let posAndVel = propagate(satRec, dayjs(JulianDate.toDate(time)).tz('America/New_York').toDate());
        const gmst = gstime(dayjs(JulianDate.toDate(time)).tz('America/New_York').toDate());
        const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
        let longitude = geoPosVel.longitude,
            latitude  = geoPosVel.latitude,
            height    = geoPosVel.height * 1000;
        this.savedCart = new Cartesian3.fromRadians(longitude, latitude, height);
        return this.savedCart;
    }, false);
    tleProp['tleCollection'] = satObj.tleCollection;

    const orbitCallbackProp = new CallbackProperty(function(time, result) {
        let orbitPos = [];
        const satRec = this.tleCollection.findDataForIntervalContainingDate(time);
        if (satRec == null) {
            return orbitPos;
        }
        if (this.nextCalcTime != null && JulianDate.lessThan(time, this.nextCalcTime)) {
            return this.savedPos;
        }
        const radsPerMin = satRec.no; //Mean motion of satellite represented in Radians per Minute
        const minsForFullRotation = Math.round((2*Math.PI) / radsPerMin) + 1;
        if (minsForFullRotation > 1000) {
            return orbitPos;
        }
        let iMin = 0;
        let startTime = JulianDate.addMinutes(time, iMin, new JulianDate());
        while (iMin <= minsForFullRotation) {
            let posAndVel = propagate(satRec, dayjs(JulianDate.toDate(startTime)).tz('America/New_York').toDate());
            const gmst = gstime(dayjs(JulianDate.toDate(startTime)).tz('America/New_York').toDate());
            const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
            let longitude = geoPosVel.longitude,
                latitude  = geoPosVel.latitude,
                height    = geoPosVel.height * 1000;
            orbitPos.push(new Cartesian3.fromRadians(longitude, latitude, height));
            iMin += 1;
            JulianDate.addMinutes(startTime, 1, startTime);
        }
        this.nextCalcTime = JulianDate.addMinutes(time, minsForFullRotation, new JulianDate());
        this.savedPos = orbitPos;
        return orbitPos;
    }, false);
    orbitCallbackProp['tleCollection'] = satObj.tleCollection;

    const satEnt = new Entity({
        id: `Satellite: ${satObj.satellite}`,
        name: `Satellite: ${satObj.satellite}`,
        availability: satObj.tleCollection,
        properties: {
            tleCollection: satObj.tleCollection,
        },
        point: new PointGraphics({
            color: Color.YELLOW,
            pixelSize: 15
        }),
        position: tleProp
    });
    satelliteSource.entities.add(satEnt);
}
viewer.dataSources.add(satelliteSource);


//BEGIN HELPER FUNCTIONS
function buildSatelliteDescription(satellite, shipsInRange, time) {
    let shipNames = shipsInRange.map((shipEntity) => `<tr><td style="text-align: center; vertical-align: middle;">${shipEntity.name}</td></tr>`);
    if (shipNames.length === 0) {
        shipNames = [`<tr><td style="text-align: center; vertical-align: middle;">No ships found in range of ${satellite.name}.</td></tr>`];
    }
    const satRec = satellite.properties.tleCollection.getValue(time).findDataForIntervalContainingDate(time);
    const currInclination = CesiumMath.toDegrees(satRec.inclo);
    const radsPerMin = satRec.no; //Mean motion of satellite represented in Radians per Minute
    const minsForFullRotation = Math.round((2*Math.PI) / radsPerMin) + 1;
    let orbitType = 'Unknown';
    if (currInclination === 0.0) {
        orbitType = 'Prograde equatorial';
    } else if (currInclination > 0.0 && currInclination < 90.0) {
        orbitType = 'Prograde';
    } else if (currInclination === 90.0) {
        orbitType = 'Polar Orbit';
    } else if (currInclination > 90.0 && currInclination < 180.0) {
        orbitType = 'Retrograde';
    } else if (currInclination === 180.0) {
        orbitType = 'Retrograde equatorial';
    }
    return `<div>
                <div>Orbit Type: ${orbitType}</div>
                <div>Inclination (degrees): ${currInclination}</div>
                <div>Orbit Period (minutes): ${minsForFullRotation}</div>
                <table>
                <th>Ships in Range</th>
                ${shipNames.join('')}
                </table>
                </div>`;
}

function buildShipDescription(ship, satsInRange) {
    let satNames = satsInRange.map((satEntity) => `<tr><td style="text-align: center; vertical-align: middle;">${satEntity.name}</td></tr>`);
    if (satNames.length === 0) {
        satNames = [`<tr><td style="text-align: center; vertical-align: middle;">No satellites found in range of ${ship.name}.</td></tr>`];
    }
    return `<div>
                <div>MMSI: ${ship.properties['mmsi']}</div>
                <div>Vessel Type: ${ship.properties.vesselType}</div>
                <table>
                <th>Satellites in Range</th>
                ${satNames.join('')}
                </table>
                </div>`;
}

function resetEntityColors() {
    resetShipColors();
    resetSatColors();
}

function resetShipColors() {
    shipSource.entities.values.forEach((ship) => ship.point.color = Color.WHITE);
}

function createOrbitGraphics(tleCollection) {
    const orbitCallbackProp = new CallbackProperty(function(time, result) {
        let orbitPos = [];
        const satRec = this.tleCollection.findDataForIntervalContainingDate(time);
        if (satRec == null) {
            return orbitPos;
        }
        const radsPerMin = satRec.no; //Mean motion of satellite represented in Radians per Minute
        const minsForFullRotation = Math.round((2*Math.PI) / radsPerMin) + 1;
        if (this.lastCalcTime != null && JulianDate.greaterThan(time, this.lastCalcTime) && JulianDate.lessThan(time, this.nextCalcTime)) {
            return this.savedPos;
        }

        if (minsForFullRotation > 1000) {
            return orbitPos;
        }
        let iMin = 0;
        let startTime = JulianDate.addMinutes(time, iMin, new JulianDate());
        while (iMin <= minsForFullRotation) {
            let posAndVel = propagate(satRec, dayjs(JulianDate.toDate(startTime)).tz('America/New_York').toDate());
            const gmst = gstime(dayjs(JulianDate.toDate(startTime)).tz('America/New_York').toDate());
            const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
            let longitude = geoPosVel.longitude,
                latitude  = geoPosVel.latitude,
                height    = geoPosVel.height * 1000;
            orbitPos.push(new Cartesian3.fromRadians(longitude, latitude, height));
            iMin += 1;
            JulianDate.addMinutes(startTime, 1, startTime);
        }
        this.lastCalcTime = time;
        this.nextCalcTime = JulianDate.addMinutes(time, minsForFullRotation, new JulianDate());
        this.savedPos = orbitPos;
        return orbitPos;
    }, false);
    orbitCallbackProp['tleCollection'] = tleCollection;
    return new PolylineGraphics({
        positions: orbitCallbackProp,
        width: 2,
        material: Color.ALICEBLUE,
        show: true,
    });
}

function resetSatColors() {
    satelliteSource.entities.values.forEach((sat) => {
        sat.point.color = Color.YELLOW;
        if (sat.polyline != null && sat !== viewer.selectedEntity) {
            sat.polyline = null;
        }
    });
}

function collectInDistance(position, currentTime, satellites = true ) {
    let source = satelliteSource;
    if (satellites === false) {
        source = shipSource;
    }
    const availableEnts = source.entities.values.filter((entity) => entity.isAvailable(currentTime));
    const inRange = [];
    for (const availableEnt of availableEnts) {
        try {
            const entPos = Cartographic.fromCartesian(availableEnt.position.getValue(currentTime));

            const ellipsoidLine = new EllipsoidGeodesic(entPos, position);
            const dist = ellipsoidLine.surfaceDistance;
            if (dist / 1000 < 10018) {
                inRange.push(availableEnt);
            }
        } catch (e) { }
    }
    return inRange;
}

function colorShipsByDistance(satPos, currentTime) {
    const ships = shipSource.entities.values.filter((entity) => entity.isAvailable(currentTime));
    for (const shipAvailable of ships) {
        try {
            const shipPos = Cartographic.fromCartesian(shipAvailable.position.getValue(currentTime));
            // Remove height from satellite so it isn't considered in distance calculation
            satPos.height = 0.0;
            const ellipsoidLine = new EllipsoidGeodesic(shipPos, satPos);
            const dist = ellipsoidLine.surfaceDistance;
            if (dist / 1000 < 10018) {
                shipAvailable.point.color = Color.BLUE;
            } else {
                shipAvailable.point.color = Color.RED;
            }
        } catch (e) {
            shipAvailable.point.color = Color.WHITE;
        }
    }
}

function colorSatellitesByDistance(shipPos, currentTime) {
    const satellites = satelliteSource.entities.values.filter((entity) => entity.isAvailable(currentTime));
    for (const satAvailable of satellites) {
        try {
            const satPos = Cartographic.fromCartesian(satAvailable.position.getValue(currentTime));
            // Remove height from satellite so it isn't considered in distance calculation
            satPos.height = 0.0;
            const ellipsoidLine = new EllipsoidGeodesic(shipPos, satPos);
            const dist = ellipsoidLine.surfaceDistance;
            if (dist / 1000 < 10018) {
                satAvailable.point.color = Color.BLUE;
            } else {
                satAvailable.point.color = Color.RED;
            }
        } catch (e) {
            satAvailable.point.color = Color.YELLOW;
        }
    }
}

function revertSatelliteColors() {
    if (coloredSats.length > 0) {
        //TODO: Get cesium entities and revert back to default color
        for (const satName of coloredSats) {
            const satEnt = satelliteSource.entities.getById(satName);
            if (defined(satEnt)) {
                satEnt.point.color = Color.YELLOW;
            }
        }
        coloredSats = [];
    }
    hitSource.entities.removeAll();
}

function getOrbitSample(satRec, minutesSinceEpoch) {
    let posAndVel = sgp4(satRec, minutesSinceEpoch);

    const satEpoch = new JulianDate(satRec.jdsatepoch);
    const time = JulianDate.addMinutes(satEpoch, minutesSinceEpoch, satEpoch);
    const gmst = gstime(time.dayNumber);
    const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
    let longitude = geoPosVel.longitude,
        latitude  = geoPosVel.latitude,
        height    = geoPosVel.height * 1000;
    const cartPos = Cartesian3.fromRadians(longitude, latitude, height);
    return cartPos;
}

function getSatellitePosition(time, satRec) {
    let posAndVel = propagate(satRec, time);

    const gmst = gstime(time);
    const geoPosVel = eciToGeodetic(posAndVel.position, gmst);
    let longitude = geoPosVel.longitude,
        latitude  = geoPosVel.latitude,
        height    = geoPosVel.height * 1000;
    const cartPos = Cartesian3.fromRadians(longitude, latitude, height);
    return cartPos;
}
