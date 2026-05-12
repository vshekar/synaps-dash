'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchArrayInfo, fetchArrayBuffer, type TiledDataType } from '@/lib/tiled/client';

interface NiiVueViewerProps {
  path: string;
}

// Map tiled dtype (kind/itemsize) → NIfTI-1 datatype code + bitpix.
function niftiDatatype(kind: string, itemsize: number): { datatype: number; bitpix: number } {
  if (kind === 'u' && itemsize === 1) return { datatype: 2, bitpix: 8 };
  if (kind === 'i' && itemsize === 1) return { datatype: 256, bitpix: 8 };
  if (kind === 'u' && itemsize === 2) return { datatype: 512, bitpix: 16 };
  if (kind === 'i' && itemsize === 2) return { datatype: 4, bitpix: 16 };
  if (kind === 'u' && itemsize === 4) return { datatype: 768, bitpix: 32 };
  if (kind === 'i' && itemsize === 4) return { datatype: 8, bitpix: 32 };
  if (kind === 'f' && itemsize === 4) return { datatype: 16, bitpix: 32 };
  if (kind === 'f' && itemsize === 8) return { datatype: 64, bitpix: 64 };
  throw new Error(`Unsupported dtype kind=${kind}, itemsize=${itemsize}`);
}

// Wrap a raw C-order 3D array in a NIfTI-1 .nii buffer so NiiVue can parse it
// without any server-side conversion. Tiled shape [D, H, W] → NIfTI dim [W, H, D]
// (NIfTI lists fastest-varying axis first).
function buildNifti(shape: number[], dtype: TiledDataType, data: ArrayBuffer): Uint8Array {
  const [D, H, W] = shape;
  const { datatype, bitpix } = niftiDatatype(dtype.kind, dtype.itemsize);
  const VOX_OFFSET = 352;
  const out = new Uint8Array(VOX_OFFSET + data.byteLength);
  const view = new DataView(out.buffer);
  const le = true;

  view.setInt32(0, 348, le);
  out[38] = 114; // 'r'
  view.setInt16(40, 3, le);
  view.setInt16(42, W, le);
  view.setInt16(44, H, le);
  view.setInt16(46, D, le);
  view.setInt16(48, 1, le);
  view.setInt16(50, 1, le);
  view.setInt16(52, 1, le);
  view.setInt16(54, 1, le);
  view.setInt16(70, datatype, le);
  view.setInt16(72, bitpix, le);
  view.setFloat32(76, 1, le);
  view.setFloat32(80, 1, le);
  view.setFloat32(84, 1, le);
  view.setFloat32(88, 1, le);
  view.setFloat32(108, VOX_OFFSET, le);
  view.setFloat32(112, 1, le);
  view.setFloat32(116, 0, le);
  out[123] = 2; // xyzt_units: mm
  view.setInt16(252, 0, le); // qform_code
  view.setInt16(254, 1, le); // sform_code = scanner anat
  // sform identity: voxel index → world (no translation, unit spacing)
  view.setFloat32(280, 1, le);
  view.setFloat32(300, 1, le);
  view.setFloat32(320, 1, le);
  // magic "n+1\0"
  out[344] = 110; out[345] = 43; out[346] = 49; out[347] = 0;

  out.set(new Uint8Array(data), VOX_OFFSET);
  return out;
}

export function NiiVueViewer({ path }: NiiVueViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const [niivueMod, info, { buffer }] = await Promise.all([
          import('@niivue/niivue'),
          fetchArrayInfo(path),
          fetchArrayBuffer(path),
        ]);
        if (cancelled) return;

        if (info.shape.length !== 3) {
          throw new Error(`Expected 3D array, got ${info.shape.length}D`);
        }

        const niftiBytes = buildNifti(info.shape, info.dtype, buffer);
        if (cancelled || !canvasRef.current) return;

        const { Niivue, NVImage } = niivueMod;
        // Integer arrays are typically segmentation labels — render with a
        // categorical colormap. Continuous data gets viridis.
        const colormap = info.dtype.kind === 'i' ? 'freesurfer' : 'viridis';

        const nv = new Niivue({
          backColor: [0.07, 0.08, 0.10, 1],
          show3Dcrosshair: true,
          isResizeCanvas: true,
        });
        await nv.attachToCanvas(canvasRef.current);

        const img = await NVImage.loadFromUrl({
          url: 'volume.nii',
          name: 'volume.nii',
          buffer: niftiBytes.buffer as ArrayBuffer,
          colormap,
        });
        if (cancelled) return;

        nv.addVolume(img);
        nv.setSliceType(nv.sliceTypeMultiplanar);

        if (!cancelled) setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error('[NiiVueViewer] load error:', err);
          setError(err instanceof Error ? err.message : 'Failed to load 3D volume');
          setIsLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="relative aspect-square rounded-xl overflow-hidden border border-border-subtle bg-surface-ground">
      <canvas ref={canvasRef} className="block w-full h-full" />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-ground/80 backdrop-blur-sm">
          <div className="text-center">
            <Loader2 className="h-6 w-6 text-beam animate-spin mx-auto mb-2" />
            <p className="text-xs text-text-tertiary">Loading 3D volume…</p>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-4 bg-surface-ground/95">
          <p className="text-error text-sm text-center">{error}</p>
        </div>
      )}
    </div>
  );
}
