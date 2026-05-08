'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchThumbnail } from '@/lib/tiled/client';
import { VIRIDIS_LUT } from '@/lib/tiled/colormap';

// Viridis colormap stops for colorbar SVG
const VIRIDIS_STOPS = [
  { offset: 0, color: '#440154' },
  { offset: 0.25, color: '#3b528b' },
  { offset: 0.5, color: '#21918c' },
  { offset: 0.75, color: '#5ec962' },
  { offset: 1, color: '#fde725' },
];

// Apply Viridis colormap to a grayscale image using Canvas
async function applyColormapToImage(imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      // Draw original image
      ctx.drawImage(img, 0, 0);

      // Get image data
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // Apply colormap
      for (let i = 0; i < data.length; i += 4) {
        // Use red channel as grayscale value (R=G=B for grayscale)
        const gray = data[i];
        const [r, g, b] = VIRIDIS_LUT[gray];
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        // Alpha stays the same
      }

      // Put colorized data back
      ctx.putImageData(imageData, 0, 0);

      // Convert to blob URL
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(URL.createObjectURL(blob));
        } else {
          reject(new Error('Failed to create blob'));
        }
      }, 'image/png');
    };

    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
}

interface BoundingBox {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  groupName?: string;
}

interface FormattedUnion {
  image_center?: [number, number];
  image_radius?: number;
  image_length?: number;
  cx?: number;
  cy?: number;
  num_x?: number;
  num_y?: number;
  color?: string;
  text?: string;
  label?: string;
}

interface FineScansTableRow {
  cx: number;
  cy: number;
  num_x: number;
  num_y: number;
  label?: string;
  color?: string;
}

interface GroupData {
  formatted_unions?: Record<string, FormattedUnion>;
  fine_scans_table?: Record<string, FineScansTableRow> | FineScansTableRow[];
}

interface ArrayViewerProps {
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
  showScalebar?: boolean;
  showColorbar?: boolean;
  scalebarUnit?: 'µm' | 'nm';
  colormap?: 'viridis' | 'grayscale';
  // For 3D arrays: total number of slices
  numSlices?: number;
  // Full array shape for computing proper slice indices
  arrayShape?: number[];
  // External segmentation table data for overlay
  segmentationRows?: Record<string, unknown>[] | null;
}

// Color palette for different groups - cosmic theme
const GROUP_COLORS = [
  '#2dd4bf', // beam (teal)
  '#a78bfa', // cell (purple)
  '#60a5fa', // data (blue)
  '#f472b6', // nova (pink)
  '#4ade80', // live (green)
  '#fbbf24', // warning (gold)
];

// Extract bounding boxes from metadata
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBoundingBoxes(
  metadata?: Record<string, any>,
  segmentationRows?: Record<string, unknown>[] | null
): BoundingBox[] {
  const boxes: BoundingBox[] = [];
  if (!metadata && !segmentationRows) return boxes;

  const stepSize = metadata?.step_size || 1;

  // Try multiple sources for origin coordinates
  // 1. roi_positions.x_start/y_start (legacy format)
  // 2. start_doc.scan.scan_input [x_start, x_end, x_points, y_start, y_end, y_points]
  // 3. scan_params.mot1_s/mot2_s
  let xStart = metadata?.roi_positions?.x_start;
  let yStart = metadata?.roi_positions?.y_start;

  if (xStart === undefined && metadata?.start_doc?.scan?.scan_input) {
    const scanInput = metadata.start_doc.scan.scan_input as number[];
    xStart = scanInput[0]; // x_start
    yStart = scanInput[3]; // y_start
  }

  if (xStart === undefined && metadata?.scan_params) {
    xStart = metadata.scan_params.mot1_s as number;
    yStart = metadata.scan_params.mot2_s as number;
  }

  xStart = xStart ?? 0;
  yStart = yStart ?? 0;

  let colorIndex = 0;

  // Method 1: Extract from groups -> formatted_unions (pixel coordinates)
  if (metadata?.groups) {
    for (const [groupName, groupDataRaw] of Object.entries(metadata.groups)) {
      const groupData = groupDataRaw as GroupData;
      const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length];

      // Check for formatted_unions with image_center (pixel coords)
      if (groupData.formatted_unions) {
        for (const [name, union] of Object.entries(groupData.formatted_unions)) {
          if (union.image_center) {
            // Pixel coordinates - use directly
            const [cx, cy] = union.image_center;
            const size = union.image_length ?? (union.image_radius ? union.image_radius * 2 : 20);

            boxes.push({
              name: union.text || union.label || name,
              x: cx - size / 2,
              y: cy - size / 2,
              width: size,
              height: size,
              color,
              groupName,
            });
          } else if (union.cx !== undefined && union.cy !== undefined) {
            // Real-world coordinates - need conversion
            const numX = union.num_x || 10;
            const numY = union.num_y || 10;
            const size = ((numX + numY) / 2) / stepSize;
            const x = (union.cx - xStart) / stepSize - size / 2;
            const y = (union.cy - yStart) / stepSize - size / 2;

            boxes.push({
              name: union.text || union.label || name,
              x,
              y,
              width: size,
              height: size,
              color,
              groupName,
            });
          }
        }
      }

      // Check for fine_scans_table (table format from PR)
      if (groupData.fine_scans_table) {
        const table = groupData.fine_scans_table;
        const rows = Array.isArray(table) ? table : Object.values(table);

        for (const row of rows) {
          if (row.cx !== undefined && row.cy !== undefined) {
            const numX = row.num_x || 10;
            const numY = row.num_y || 10;
            const size = ((numX + numY) / 2) / stepSize;
            const x = (row.cx - xStart) / stepSize - size / 2;
            const y = (row.cy - yStart) / stepSize - size / 2;

            boxes.push({
              name: row.label || `${groupName} region`,
              x,
              y,
              width: size,
              height: size,
              color,
              groupName,
            });
          }
        }
      }

      colorIndex++;
    }
  }

  // Method 2: Extract from top-level fine_scans_tables
  if (metadata?.fine_scans_tables) {
    for (const [groupName, tableRaw] of Object.entries(metadata.fine_scans_tables)) {
      const table = tableRaw as Record<string, FineScansTableRow> | FineScansTableRow[];
      const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length];
      const rows = Array.isArray(table) ? table : Object.values(table);

      for (const row of rows) {
        if (row.cx !== undefined && row.cy !== undefined) {
          const numX = row.num_x || 10;
          const numY = row.num_y || 10;
          const size = ((numX + numY) / 2) / stepSize;
          const x = (row.cx - xStart) / stepSize - size / 2;
          const y = (row.cy - yStart) / stepSize - size / 2;

          boxes.push({
            name: row.label || `${groupName} region`,
            x,
            y,
            width: size,
            height: size,
            color,
            groupName,
          });
        }
      }
      colorIndex++;
    }
  }

  // Method 3: Add boxes from external segmentation table data
  // cx, cy are in microns (real-world coordinates), need conversion to pixels
  if (segmentationRows && segmentationRows.length > 0) {
    const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length];
    for (const row of segmentationRows) {
      const cx = row.cx as number;
      const cy = row.cy as number;
      const numX = (row.num_x as number) || 10;
      const numY = (row.num_y as number) || 10;
      if (cx !== undefined && cy !== undefined) {
        // Convert micron coordinates to pixel coordinates
        // Size in pixels = size in microns / step_size
        const widthPx = numX / stepSize;
        const heightPx = numY / stepSize;
        // Center position in pixels = (position - start) / step_size
        const centerXPx = (cx - xStart) / stepSize;
        const centerYPx = (cy - yStart) / stepSize;
        // Box top-left corner
        const x = centerXPx - widthPx / 2;
        const y = centerYPx - heightPx / 2;
        boxes.push({
          name: (row.label as string) || `Cell ${boxes.length + 1}`,
          x,
          y,
          width: widthPx,
          height: heightPx,
          color,
          groupName: 'Segmentation',
        });
      }
    }
  }

  return boxes;
}

// Calculate a nice scalebar length (rounds to 1, 2, 5, 10, 20, 50, etc.)
function calculateScalebarLength(imageWidthUnits: number): number {
  const targetLength = imageWidthUnits * 0.2; // ~20% of image width
  const magnitude = Math.pow(10, Math.floor(Math.log10(targetLength)));
  const normalized = targetLength / magnitude;

  let nice: number;
  if (normalized < 1.5) nice = 1;
  else if (normalized < 3.5) nice = 2;
  else if (normalized < 7.5) nice = 5;
  else nice = 10;

  return nice * magnitude;
}

export function ArrayViewer({
  path,
  metadata,
  showScalebar = true,
  showColorbar = true,
  scalebarUnit = 'µm',
  colormap = 'viridis',
  numSlices,
  arrayShape,
  segmentationRows,
}: ArrayViewerProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [currentSlice, setCurrentSlice] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const boundingBoxes = extractBoundingBoxes(metadata, segmentationRows);

  // Extract metadata values
  const stepSize = metadata?.step_size || 0.02; // default 20nm = 0.02µm
  const element = metadata?.element;
  const scanId = metadata?.scan_id;

  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;

    const load = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Compute slice expression based on array dimensionality
        // For 3D [N, H, W]: slice=currentSlice
        // For 4D [1, N, H, W]: slice=0,currentSlice (let tiled infer remaining dims)
        // For 4D [N, M, H, W]: slice=0,currentSlice
        let sliceExpr: number | string = currentSlice;
        if (arrayShape && arrayShape.length === 4) {
          // 4D array: just provide indices for first two dimensions
          // Tiled should return the remaining 2D slice
          sliceExpr = `0,${currentSlice}`;
        }

        // Fetch grayscale image from Tiled with current slice
        const grayscaleUrl = await fetchThumbnail(path, 'viridis', sliceExpr);
        if (cancelled || !grayscaleUrl) return;

        // Apply colormap if requested
        if (colormap === 'viridis') {
          const colorizedUrl = await applyColormapToImage(grayscaleUrl);
          // Revoke the grayscale URL since we don't need it anymore
          URL.revokeObjectURL(grayscaleUrl);
          currentUrl = colorizedUrl;
        } else {
          currentUrl = grayscaleUrl;
        }

        if (!cancelled) setImageUrl(currentUrl);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load image');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [path, colormap, currentSlice, arrayShape]);

  // Track container width for scaling
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center aspect-square rounded-xl bg-surface-raised border border-border-subtle">
        <div className="text-center">
          <Loader2 className="h-6 w-6 text-beam animate-spin mx-auto mb-2" />
          <p className="text-xs text-text-tertiary">Loading image...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center aspect-square rounded-xl bg-surface-raised border border-border-subtle">
        <div className="text-center p-6">
          <p className="text-error text-sm font-medium mb-1">Failed to load image</p>
          <p className="text-text-tertiary text-xs">{error}</p>
        </div>
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div className="flex items-center justify-center aspect-square rounded-xl bg-surface-raised border border-border-subtle">
        <p className="text-text-tertiary text-sm">No image available</p>
      </div>
    );
  }

  // Calculate scale factor for bounding boxes
  const scale = imageDimensions && containerWidth > 0
    ? containerWidth / imageDimensions.width
    : 1;

  // Get unique group names for legend
  const groupNames = [...new Set(boundingBoxes.map(b => b.groupName).filter(Boolean))];

  // Calculate scalebar dimensions
  const imageWidthUnits = imageDimensions
    ? imageDimensions.width * (scalebarUnit === 'nm' ? stepSize * 1000 : stepSize)
    : 0;
  const scalebarLength = calculateScalebarLength(imageWidthUnits);
  const scalebarPixels = imageDimensions
    ? scalebarLength / (scalebarUnit === 'nm' ? stepSize * 1000 : stepSize)
    : 0;

  return (
    <div className="relative rounded-xl overflow-hidden border border-border-subtle bg-surface-ground">
      <div className="flex">
        {/* Main image container with padding wrapper */}
        <div className="flex-1 aspect-square bg-void/30 p-3">
          <div ref={containerRef} className="relative w-full h-full">
            <img
              src={imageUrl}
              alt="Array visualization"
              className="w-full h-full object-contain"
              onLoad={handleImageLoad}
            />

            {/* SVG overlay for bounding boxes, scalebar, and title */}
            {imageDimensions && (
              <svg
                className="absolute top-0 left-0 w-full h-full pointer-events-none"
                viewBox={`0 0 ${imageDimensions.width} ${imageDimensions.height}`}
                preserveAspectRatio="xMidYMid meet"
              >
              {/* Bounding boxes */}
              {boundingBoxes.map((box, idx) => {
                const labelWidth = Math.max(box.name.length * 2 / scale + 2 / scale, 10 / scale);
                const labelHeight = 4 / scale;
                return (
                  <g key={idx}>
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      fill="none"
                      stroke={box.color}
                      strokeWidth={Math.max(0.25, 0.5 / scale)}
                    />
                    <rect
                      x={box.x + box.width / 2 - labelWidth / 2}
                      y={box.y + 1 / scale}
                      width={labelWidth}
                      height={labelHeight}
                      fill="rgba(0, 0, 0, 0.75)"
                      rx={0.5 / scale}
                    />
                    <text
                      x={box.x + box.width / 2}
                      y={box.y + 1 / scale + labelHeight * 0.75}
                      fill={box.color}
                      fontSize={2.5 / scale}
                      fontFamily="ui-monospace, monospace"
                      fontWeight="500"
                      textAnchor="middle"
                    >
                      {box.name}
                    </text>
                  </g>
                );
              })}

              {/* Scalebar - bottom right */}
              {showScalebar && scalebarPixels > 0 && (
                <g>
                  {/* Scalebar background */}
                  <rect
                    x={imageDimensions.width - scalebarPixels - 20}
                    y={imageDimensions.height - 35}
                    width={scalebarPixels + 10}
                    height={25}
                    fill="rgba(0, 0, 0, 0.6)"
                    rx={4}
                  />
                  {/* Scalebar bar */}
                  <rect
                    x={imageDimensions.width - scalebarPixels - 15}
                    y={imageDimensions.height - 18}
                    width={scalebarPixels}
                    height={4}
                    fill="white"
                  />
                  {/* Scalebar label */}
                  <text
                    x={imageDimensions.width - scalebarPixels / 2 - 15}
                    y={imageDimensions.height - 22}
                    fill="white"
                    fontSize={10}
                    fontFamily="ui-monospace, monospace"
                    fontWeight="500"
                    textAnchor="middle"
                  >
                    {scalebarLength < 1 ? scalebarLength.toFixed(2) : scalebarLength} {scalebarUnit}
                  </text>
                </g>
              )}

            </svg>
          )}

          {/* Subtle gradient overlay */}
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-surface-ground/30 via-transparent to-transparent" />

          {/* Slice slider for 3D arrays */}
          {numSlices && numSlices > 1 && (
            <div className="absolute bottom-2 left-2 right-2 px-3 py-2 rounded-md bg-surface-ground/90 backdrop-blur-sm border border-border-subtle">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentSlice(Math.max(0, currentSlice - 1))}
                  disabled={currentSlice === 0}
                  className="p-1 rounded hover:bg-surface-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4 text-text-secondary" />
                </button>
                <span className="text-xs text-text-secondary font-mono whitespace-nowrap min-w-[70px] text-center">
                  {currentSlice + 1} / {numSlices}
                </span>
                <button
                  onClick={() => setCurrentSlice(Math.min(numSlices - 1, currentSlice + 1))}
                  disabled={currentSlice === numSlices - 1}
                  className="p-1 rounded hover:bg-surface-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4 text-text-secondary" />
                </button>
                <input
                  type="range"
                  min={0}
                  max={numSlices - 1}
                  value={currentSlice}
                  onChange={(e) => setCurrentSlice(parseInt(e.target.value))}
                  className="flex-1 h-1 bg-border-medium rounded-lg appearance-none cursor-pointer accent-beam"
                />
              </div>
            </div>
          )}

          {/* Legend and count indicator */}
          {boundingBoxes.length > 0 && (
            <div className="absolute top-2 right-2 px-2 py-1.5 rounded-md bg-surface-ground/90 backdrop-blur-sm border border-border-subtle">
              <div className="text-xs font-mono text-text-secondary mb-1">
                {boundingBoxes.length} region{boundingBoxes.length !== 1 ? 's' : ''} detected
              </div>
              {groupNames.length > 1 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {groupNames.map((name, i) => (
                    <div key={name} className="flex items-center gap-1">
                      <div
                        className="w-2 h-2 rounded-sm"
                        style={{ backgroundColor: GROUP_COLORS[i % GROUP_COLORS.length] }}
                      />
                      <span className="text-[10px] text-text-tertiary">{name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        {/* Colorbar - right side */}
        {showColorbar && imageDimensions && (
          <div className="w-12 flex flex-col items-center justify-center py-4 px-2">
            <svg width="24" height="200" className="flex-shrink-0">
              <defs>
                <linearGradient id="viridis-gradient" x1="0%" y1="100%" x2="0%" y2="0%">
                  {VIRIDIS_STOPS.map((stop) => (
                    <stop key={stop.offset} offset={`${stop.offset * 100}%`} stopColor={stop.color} />
                  ))}
                </linearGradient>
              </defs>
              {/* Colorbar rectangle */}
              <rect
                x={4}
                y={10}
                width={16}
                height={180}
                fill="url(#viridis-gradient)"
                stroke="rgba(255,255,255,0.3)"
                strokeWidth={1}
                rx={2}
              />
              {/* Tick marks and labels */}
              <text x={12} y={8} fill="currentColor" fontSize={8} textAnchor="middle" className="text-text-secondary">High</text>
              <text x={12} y={198} fill="currentColor" fontSize={8} textAnchor="middle" className="text-text-secondary">Low</text>
            </svg>
            {element && (
              <div className="text-[10px] text-text-tertiary mt-2 text-center writing-mode-vertical" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                {element} Intensity
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
