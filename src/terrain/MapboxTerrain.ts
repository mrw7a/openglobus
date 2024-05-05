import * as mercator from "../mercator";
import {Extent} from "../Extent";
import {getTileExtent} from "../mercator";
import {GlobusTerrain, IGlobusTerrainParams} from "./GlobusTerrain";
import {isPowerOfTwo} from "../math";
import {Layer} from "../layer/Layer";
import {LonLat} from "../LonLat";
import {Segment} from "../segment/Segment";
import {binarySearchFast, TypedArray} from "../utils/shared";
import {IResponse} from "../utils/Loader";

interface IMapboxTerrainParams extends IGlobusTerrainParams {
    equalizeNormals?: boolean;
    key?: string;
    imageSize?: number;
}

/**
 * The key doesn't work; just an example!
 */
const KEY = "pk.eyJ1IjoiZm94bXVsZGVyODMiLCJhIjoiY2pqYmR3dG5oM2Z1bzNrczJqYm5pODhuNSJ9.Y4DRmEPhb-XSlCR9CAXACQ";

const rgb2Height = (r: number, g: number, b: number): number => {
    return -10000 + 0.1 * (r * 256 * 256 + g * 256 + b);
};

class MapboxTerrain extends GlobusTerrain {

    protected _imageSize: number;

    protected _ctx: CanvasRenderingContext2D;

    protected _imageDataCache: Record<string, Uint8ClampedArray>;

    constructor(name: string | null, options: IMapboxTerrainParams = {}) {
        super(name || "MapboxTerrain", {
            equalizeVertices: options.equalizeVertices != undefined ? options.equalizeVertices : true,
            maxZoom: options.maxZoom || 17,
            noDataValues: options.noDataValues || [-65537, -10000],
            plainGridSize: options.plainGridSize || 128,
            url: options.url != undefined
                ? options.url
                : `//api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token=${options.key || KEY}`,
            gridSizeByZoom: options.gridSizeByZoom || [
                64, 32, 16, 8, 8, 8, 8, 16, 16, 16, 16, 16, 32, 16, 32, 16, 32, 16, 32, 16, 8, 4
            ],
            ...options
        });

        this.equalizeNormals = options.equalizeNormals || false;

        this._dataType = "imageBitmap";

        this._imageSize = options.imageSize || 256;

        this._ctx = this._createTemporalCanvas(this._imageSize);

        this._imageDataCache = {};
    }

    static override checkNoDataValue(noDataValues: number[] | TypedArray, value: number): boolean {
        if (value > 50000) {
            return true;
        }
        return binarySearchFast(noDataValues, value) !== -1;
    }

    public override isBlur(segment: Segment): boolean {
        return segment.tileZoom >= 16;
    }

    protected _createTemporalCanvas(size: number): CanvasRenderingContext2D {
        let canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        return canvas.getContext("2d", {
            willReadFrequently: true
        })!;
    }

    protected override _createHeights(data: HTMLImageElement | ImageBitmap, tileIndex: string, tileX: number, tileY: number, tileZoom: number, extent: Extent, preventChildren: boolean): TypedArray | number[] {

        this._ctx.clearRect(0, 0, this._imageSize, this._imageSize);
        this._ctx.drawImage(data, 0, 0);
        let rgbaData = this._ctx.getImageData(0, 0, this._imageSize, this._imageSize).data;

        const SIZE = data.width;

        //
        //Non-power of two images
        //
        if (!isPowerOfTwo(this._imageSize) && SIZE === this._imageSize) {
            let outCurrenElevations = new Float32Array(SIZE * SIZE);
            extractElevationTilesMapboxNonPowerOfTwo(rgbaData, outCurrenElevations, this._heightFactor);
            return outCurrenElevations;
        }

        if (this._imageSize === this.plainGridSize) {
            let elevationsSize = (this.plainGridSize + 1) * (this.plainGridSize + 1);
            let outCurrenElevations = new Float32Array(elevationsSize);
            for (let k = 0, len = this._imageSize * this._imageSize; k < len; k++) {
                let j = k % this._imageSize,
                    i = Math.floor(k / this._imageSize);
                let fromInd4 = k * 4;
                let h = this._heightFactor * rgb2Height(rgbaData[fromInd4], rgbaData[fromInd4 + 1], rgbaData[fromInd4 + 2]);
                outCurrenElevations[i * (this._imageSize + 1) + j] = h;
            }

            for (let i = 0, len = this._imageSize; i < len; i++) {
                let j = this._imageSize - 1;
                let fromInd4 = (i * this._imageSize + j) * 4;
                let h = this._heightFactor * rgb2Height(rgbaData[fromInd4], rgbaData[fromInd4 + 1], rgbaData[fromInd4 + 2]);
                outCurrenElevations[i * (this._imageSize + 1) + this._imageSize] = h;
            }

            for (let j = 0, len = this._imageSize; j < len; j++) {
                let i = this._imageSize - 1;
                let fromInd4 = (i * this._imageSize + j) * 4;
                let h = this._heightFactor * rgb2Height(rgbaData[fromInd4], rgbaData[fromInd4 + 1], rgbaData[fromInd4 + 2]);
                outCurrenElevations[this._imageSize * (this._imageSize + 1) + j] = h;
            }

            let h = this._heightFactor * rgb2Height(rgbaData[rgbaData.length - 4], rgbaData[rgbaData.length - 3], rgbaData[rgbaData.length - 2]);
            outCurrenElevations[outCurrenElevations.length - 1] = h;

            return outCurrenElevations;
        }

        //
        // Power of two images
        //
        let elevationsSize = (this.plainGridSize + 1) * (this.plainGridSize + 1);

        let d = SIZE / this.plainGridSize;

        let outCurrenElevations = new Float32Array(elevationsSize);
        let outChildrenElevations = new Array(d);

        for (let i = 0; i < d; i++) {
            outChildrenElevations[i] = [];
            for (let j = 0; j < d; j++) {
                outChildrenElevations[i][j] = new Float32Array(elevationsSize);
            }
        }

        if (preventChildren) {
            extractElevationTilesMapboxNoChildren(rgbaData, this._heightFactor, this.noDataValues, outCurrenElevations);
        } else {
            extractElevationTilesMapbox(
                rgbaData,
                this._heightFactor,
                this.noDataValues,
                outCurrenElevations,
                outChildrenElevations
            );
        }

        this._elevationCache[tileIndex] = {
            heights: outCurrenElevations,
            extent: extent//segment.getExtent()
        };

        if (!preventChildren) {
            for (let i = 0; i < d; i++) {
                for (let j = 0; j < d; j++) {
                    let x = tileX * 2 + j,
                        y = tileY * 2 + i,
                        z = tileZoom + 1;
                    let tileIndex = Layer.getTileIndex(x, y, z);
                    this._elevationCache[tileIndex] = {
                        heights: outChildrenElevations[i][j],
                        extent: getTileExtent(x, y, z)
                    };
                }
            }
        }

        return outCurrenElevations;
    }

    public override getHeightAsync(lonLat: LonLat, callback: (h: number) => void, zoom?: number): boolean {
        if (!lonLat || lonLat.lat > mercator.MAX_LAT || lonLat.lat < mercator.MIN_LAT) {
            callback(0);
            return true;
        }

        let z = zoom || this.maxZoom,
            size = mercator.POLE2 / Math.pow(2, z),
            merc = mercator.forward(lonLat),
            x = Math.floor((mercator.POLE + merc.lon) / size),
            y = Math.floor((mercator.POLE - merc.lat) / size);

        let tileIndex = Layer.getTileIndex(x, y, z),
            extent = mercator.getTileExtent(x, y, z);

        let sizeImgW = extent.getWidth() / (this._imageSize - 1),
            sizeImgH = extent.getHeight() / (this._imageSize - 1);

        let i = this._imageSize - Math.ceil((merc.lat - extent.southWest.lat) / sizeImgH) - 1,
            j = Math.floor((merc.lon - extent.southWest.lon) / sizeImgW);
        let index = (i * this._imageSize + j) * 4;

        if (this._imageDataCache[tileIndex]) {
            let data = this._imageDataCache[tileIndex];
            callback(this._heightFactor * rgb2Height(data[index], data[index + 1], data[index + 2]));
            return true;
        }

        if (!this._fetchCache[tileIndex]) {
            let url = this._buildURL(x, y, z);
            this._fetchCache[tileIndex] = this._loader.fetch({
                src: url,
                type: this._dataType
            });
        }

        this._fetchCache[tileIndex].then((response: IResponse) => {
            if (response.status === "ready") {
                this._ctx.clearRect(0, 0, this._imageSize, this._imageSize);
                this._ctx.drawImage(response.data, 0, 0);
                let data = this._ctx.getImageData(0, 0, 256, 256).data;
                this._imageDataCache[tileIndex] = data;
                callback(this._heightFactor * rgb2Height(data[index], data[index + 1], data[index + 2]));
            } else if (response.status === "error") {
                callback(0);
            } else {
                //@ts-ignore
                this._fetchCache[tileIndex] = null;
                delete this._fetchCache[tileIndex];
            }
        });

        return false;
    }
}

function extractElevationTilesMapboxNonPowerOfTwo(rgbaData: number[] | TypedArray, outCurrenElevations: number[] | TypedArray, heightFactor: number = 1) {
    for (let i = 0, len = outCurrenElevations.length; i < len; i++) {
        let i4 = i * 4;
        outCurrenElevations[i] = heightFactor * rgb2Height(rgbaData[i4], rgbaData[i4 + 1], rgbaData[i4 + 2]);
    }
}

function extractElevationTilesMapbox(
    rgbaData: number[] | TypedArray,
    heightFactor: number,
    noDataValues: number[] | TypedArray,
    outCurrenElevations: number[] | TypedArray,
    outChildrenElevations: number[][][] | TypedArray[][]
) {
    let destSize = Math.sqrt(outCurrenElevations.length) - 1;
    let destSizeOne = destSize + 1;
    let sourceSize = Math.sqrt(rgbaData.length / 4);
    let dt = sourceSize / destSize;

    let rightHeight = 0,
        bottomHeight = 0,
        sourceSize4 = 0;

    for (
        let k = 0, currIndex = 0, sourceDataLength = rgbaData.length / 4;
        k < sourceDataLength;
        k++
    ) {
        let k4 = k * 4;

        let height = heightFactor * rgb2Height(rgbaData[k4], rgbaData[k4 + 1], rgbaData[k4 + 2]);

        let isNoDataCurrent = MapboxTerrain.checkNoDataValue(noDataValues, height),
            isNoDataRight = false,
            isNoDataBottom = false;

        let i = Math.floor(k / sourceSize),
            j = k % sourceSize;

        let tileX = Math.floor(j / destSize),
            tileY = Math.floor(i / destSize);

        let destArr = outChildrenElevations[tileY][tileX];

        let ii = i % destSize,
            jj = j % destSize;

        let destIndex = (ii + tileY) * destSizeOne + jj + tileX;

        destArr[destIndex] = height;

        if ((i + tileY) % dt === 0 && (j + tileX) % dt === 0) {
            outCurrenElevations[currIndex++] = height;
        }

        if ((j + 1) % destSize === 0 && j !== sourceSize - 1) {
            //current tile
            rightHeight = heightFactor * rgb2Height(rgbaData[k4 + 4], rgbaData[k4 + 5], rgbaData[k4 + 6]);

            isNoDataRight = MapboxTerrain.checkNoDataValue(noDataValues, rightHeight);

            let middleHeight = height;

            if (!(isNoDataCurrent || isNoDataRight)) {
                middleHeight = (height + rightHeight) * 0.5;
            }

            destIndex = (ii + tileY) * destSizeOne + jj + 1;
            destArr[destIndex] = middleHeight;

            if ((i + tileY) % dt === 0) {
                outCurrenElevations[currIndex++] = middleHeight;
            }

            //next right tile
            let rightindex = (ii + tileY) * destSizeOne + ((jj + 1) % destSize);
            outChildrenElevations[tileY][tileX + 1][rightindex] = middleHeight;
        }

        if ((i + 1) % destSize === 0 && i !== sourceSize - 1) {
            //current tile
            sourceSize4 = sourceSize * 4;

            bottomHeight = heightFactor * rgb2Height(rgbaData[k4 + sourceSize4], rgbaData[k4 + sourceSize4 + 1], rgbaData[k4 + sourceSize4 + 2]);

            isNoDataBottom = MapboxTerrain.checkNoDataValue(noDataValues, bottomHeight);

            let middleHeight = (height + bottomHeight) * 0.5;

            if (!(isNoDataCurrent || isNoDataBottom)) {
                middleHeight = (height + bottomHeight) * 0.5;
            }

            destIndex = (ii + 1) * destSizeOne + jj + tileX;
            destArr[destIndex] = middleHeight;

            if ((j + tileX) % dt === 0) {
                outCurrenElevations[currIndex++] = middleHeight;
            }

            //next bottom tile
            let bottomindex = ((ii + 1) % destSize) * destSizeOne + jj + tileX;
            outChildrenElevations[tileY + 1][tileX][bottomindex] = middleHeight;
        }

        if (
            (j + 1) % destSize === 0 && j !== sourceSize - 1 &&
            (i + 1) % destSize === 0 && i !== sourceSize - 1
        ) {
            //current tile
            let rightBottomHeight = heightFactor * rgb2Height(rgbaData[k4 + sourceSize4 + 4], rgbaData[k4 + sourceSize4 + 5], rgbaData[k4 + sourceSize4 + 6]);

            let isNoDataRightBottom = MapboxTerrain.checkNoDataValue(noDataValues, rightBottomHeight);

            let middleHeight = height;

            if (!(isNoDataCurrent || isNoDataRight || isNoDataBottom || isNoDataRightBottom)) {
                middleHeight = (height + rightHeight + bottomHeight + rightBottomHeight) * 0.25;
            }

            destIndex = (ii + 1) * destSizeOne + (jj + 1);
            destArr[destIndex] = middleHeight;

            outCurrenElevations[currIndex++] = middleHeight;

            //next right tile
            let rightindex = (ii + 1) * destSizeOne;
            outChildrenElevations[tileY][tileX + 1][rightindex] = middleHeight;

            //next bottom tile
            let bottomindex = destSize;
            outChildrenElevations[tileY + 1][tileX][bottomindex] = middleHeight;

            //next right bottom tile
            let rightBottomindex = 0;
            outChildrenElevations[tileY + 1][tileX + 1][rightBottomindex] = middleHeight;
        }
    }
}

function extractElevationTilesMapboxNoChildren(
    rgbaData: number[] | TypedArray,
    heightFactor: number,
    noDataValues: number[] | TypedArray,
    outCurrenElevations: number[] | TypedArray
) {
    let destSize = Math.sqrt(outCurrenElevations.length) - 1;
    let sourceSize = Math.sqrt(rgbaData.length / 4);
    let dt = sourceSize / destSize;

    let rightHeight = 0,
        bottomHeight = 0,
        sourceSize4 = 0;

    for (
        let k = 0, currIndex = 0, sourceDataLength = rgbaData.length / 4;
        k < sourceDataLength;
        k++
    ) {
        let k4 = k * 4;

        let height = heightFactor * rgb2Height(rgbaData[k4], rgbaData[k4 + 1], rgbaData[k4 + 2]);

        let isNoDataCurrent = MapboxTerrain.checkNoDataValue(noDataValues, height),
            isNoDataRight = false,
            isNoDataBottom = false;

        let i = Math.floor(k / sourceSize),
            j = k % sourceSize;

        let tileX = Math.floor(j / destSize),
            tileY = Math.floor(i / destSize);

        if ((i + tileY) % dt === 0 && (j + tileX) % dt === 0) {
            outCurrenElevations[currIndex++] = height;
        }

        if ((j + 1) % destSize === 0 && j !== sourceSize - 1) {
            //current tile
            rightHeight = heightFactor * rgb2Height(rgbaData[k4 + 4], rgbaData[k4 + 5], rgbaData[k4 + 6]);

            isNoDataRight = MapboxTerrain.checkNoDataValue(noDataValues, rightHeight);

            let middleHeight = height;

            if (!(isNoDataCurrent || isNoDataRight)) {
                middleHeight = (height + rightHeight) * 0.5;
            }

            if ((i + tileY) % dt === 0) {
                outCurrenElevations[currIndex++] = middleHeight;
            }
        }

        if ((i + 1) % destSize === 0 && i !== sourceSize - 1) {
            //current tile
            sourceSize4 = sourceSize * 4;

            bottomHeight = heightFactor * rgb2Height(rgbaData[k4 + sourceSize4], rgbaData[k4 + sourceSize4 + 1], rgbaData[k4 + sourceSize4 + 2]);

            isNoDataBottom = MapboxTerrain.checkNoDataValue(noDataValues, bottomHeight);

            let middleHeight = (height + bottomHeight) * 0.5;

            if (!(isNoDataCurrent || isNoDataBottom)) {
                middleHeight = (height + bottomHeight) * 0.5;
            }

            if ((j + tileX) % dt === 0) {
                outCurrenElevations[currIndex++] = middleHeight;
            }
        }

        if (
            (j + 1) % destSize === 0 && j !== sourceSize - 1 &&
            (i + 1) % destSize === 0 && i !== sourceSize - 1
        ) {
            //current tile
            let rightBottomHeight = heightFactor * rgb2Height(rgbaData[k4 + sourceSize4 + 4], rgbaData[k4 + sourceSize4 + 5], rgbaData[k4 + sourceSize4 + 6]);

            let isNoDataRightBottom = MapboxTerrain.checkNoDataValue(noDataValues, rightBottomHeight);

            let middleHeight = height;

            if (!(isNoDataCurrent || isNoDataRight || isNoDataBottom || isNoDataRightBottom)) {
                middleHeight = (height + rightHeight + bottomHeight + rightBottomHeight) * 0.25;
            }

            outCurrenElevations[currIndex++] = middleHeight;
        }
    }
}

export {MapboxTerrain};
