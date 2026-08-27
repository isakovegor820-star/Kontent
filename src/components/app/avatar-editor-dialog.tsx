"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type ImageState = {
  element: HTMLImageElement;
};

function drawAvatar(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  options: { zoom: number; rotation: number; offsetX: number; offsetY: number },
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const size = canvas.width;
  const coverScale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
  const scale = coverScale * options.zoom;
  context.clearRect(0, 0, size, size);
  context.save();
  context.translate(
    size / 2 + (options.offsetX / 100) * size * 0.38,
    size / 2 + (options.offsetY / 100) * size * 0.38,
  );
  context.rotate((options.rotation * Math.PI) / 180);
  context.scale(scale, scale);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  context.restore();
}

export function AvatarEditorDialog({
  file,
  onCancel,
  onApply,
}: {
  file: File;
  onCancel: () => void;
  onApply: (blob: Blob) => Promise<void> | void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const [image, setImage] = useState<ImageState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const reader = new FileReader();
    const element = new Image();
    element.onload = () => {
      if (!cancelled) setImage({ element });
    };
    element.onerror = () => {
      if (!cancelled) setError("Не удалось открыть фотографию.");
    };
    reader.onload = () => {
      if (!cancelled && typeof reader.result === "string") element.src = reader.result;
    };
    reader.onerror = () => {
      if (!cancelled) setError("Не удалось прочитать фотографию.");
    };
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
      reader.abort();
      element.src = "";
    };
  }, [file]);

  useEffect(() => {
    if (canvasRef.current && image) {
      drawAvatar(canvasRef.current, image.element, { zoom, rotation, offsetX, offsetY });
    }
  }, [image, zoom, rotation, offsetX, offsetY]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);

  const reset = () => {
    setZoom(1);
    setRotation(0);
    setOffsetX(0);
    setOffsetY(0);
  };

  const apply = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !image || saving) return;
    setSaving(true);
    setError("");
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      if (!blob) throw new Error("Не удалось подготовить фотографию.");
      await onApply(blob);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Не удалось подготовить фотографию.");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="avatar-editor-title">
      <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-lg border border-line bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="avatar-editor-title" className="text-[18px] font-extrabold text-text">Редактор фотографии</h2>
            <p className="mt-1 text-[13px] text-text-3">Перетащи изображение, настрой масштаб и поворот.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Закрыть редактор" onClick={onCancel} disabled={saving}>
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </header>

        <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="mx-auto w-full max-w-[26rem]">
            <div className="overflow-hidden rounded-md bg-surface-inset p-3">
              <canvas
                ref={canvasRef}
                width={512}
                height={512}
                aria-label="Предпросмотр квадратного аватара"
                className="aspect-square w-full cursor-grab touch-none rounded-sm bg-surface active:cursor-grabbing"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragRef.current = { x: event.clientX, y: event.clientY, offsetX, offsetY };
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setOffsetX(Math.max(-100, Math.min(100, drag.offsetX + ((event.clientX - drag.x) / rect.width) * 100)));
                  setOffsetY(Math.max(-100, Math.min(100, drag.offsetY + ((event.clientY - drag.y) / rect.height) * 100)));
                }}
                onPointerUp={() => { dragRef.current = null; }}
                onPointerCancel={() => { dragRef.current = null; }}
              />
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-sm bg-surface-inset p-3">
              <span className="text-[12px] font-semibold text-text-3">В интерфейсе</span>
              <div className="h-16 w-16 overflow-hidden rounded-full border-4 border-surface shadow-soft">
                <canvas
                  width={512}
                  height={512}
                  className="h-full w-full"
                  ref={(node) => {
                    if (node && image) drawAvatar(node, image.element, { zoom, rotation, offsetX, offsetY });
                  }}
                />
              </div>
            </div>
          </div>

          <div className="space-y-5">
            <label className="block">
              <span className="flex justify-between text-[13px] font-semibold text-text"><span>Масштаб</span><span>{zoom.toFixed(1)}×</span></span>
              <input className="aurora-range mt-2 w-full" type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.currentTarget.value))} />
            </label>
            <label className="block">
              <span className="flex justify-between text-[13px] font-semibold text-text"><span>Поворот</span><span>{rotation}°</span></span>
              <input className="aurora-range mt-2 w-full" type="range" min="-180" max="180" step="1" value={rotation} onChange={(event) => setRotation(Number(event.currentTarget.value))} />
            </label>
            <Button type="button" variant="outline" size="sm" onClick={reset} disabled={saving}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              Сбросить
            </Button>
            <p className="text-[12px] leading-relaxed text-text-3">Итоговый файл будет сохранён в WebP 512×512. Исходная фотография не публикуется.</p>
          </div>
        </div>

        {error ? <p role="alert" className="mx-5 mb-3 rounded-sm bg-danger-soft p-3 text-[13px] text-danger-text">{error}</p> : null}
        <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Отмена</Button>
          <Button type="button" variant="brand" onClick={() => void apply()} loading={saving} disabled={!image || saving}>Применить фотографию</Button>
        </footer>
      </div>
    </div>
  );
}
