import { useLayoutEffect, useRef } from 'react';
import { CaptureUpdateAction, FONT_FAMILY } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Pencil } from 'lucide-react';
import type { ExtensionCanvasSnapshot } from '../../types/extension-types';

type Point = readonly [number, number];

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const FONTS = new Map(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]));

function outline(element: ExcalidrawElement): readonly Point[] {
  const { width, height } = element;
  switch (element.type) {
    case 'arrow':
    case 'line':
    case 'freedraw':
      return element.points;
    case 'diamond':
      return [[width / 2, 0], [width, height / 2], [width / 2, height], [0, height / 2], [width / 2, 0]];
    case 'ellipse':
      return Array.from({ length: 49 }, (_, index) => {
        const angle = index * Math.PI / 24 - Math.PI / 2;
        return [width / 2 * (1 + Math.cos(angle)), height / 2 * (1 + Math.sin(angle))];
      });
    default: {
      const radius = element.roundness ? Math.min(element.roundness.value ?? 16, width / 4, height / 4) : 0;
      if (!radius) return [[0, 0], [width, 0], [width, height], [0, height], [0, 0]];
      const centers = [[width - radius, radius], [width - radius, height - radius],
        [radius, height - radius], [radius, radius]];
      return [...centers.flatMap(([x, y], corner) => Array.from({ length: 7 }, (_, index): Point => {
        const angle = (corner - 1) * Math.PI / 2 + index * Math.PI / 12;
        return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
      })), [width - radius, 0]];
    }
  }
}

function drawOutline(context: CanvasRenderingContext2D, points: readonly Point[], progress: number): Point {
  const lengths = points.slice(1).map(([x, y], index) => Math.hypot(x - points[index][0], y - points[index][1]));
  let remaining = lengths.reduce((total, length) => total + length, 0) * progress;
  let tip = points[0] ?? [0, 0];
  context.beginPath();
  context.moveTo(...tip);
  for (const [index, length] of lengths.entries()) {
    const [x, y] = points[index + 1];
    if (remaining < length) {
      const fraction = remaining / length;
      tip = [tip[0] + (x - tip[0]) * fraction, tip[1] + (y - tip[1]) * fraction];
      context.lineTo(...tip);
      break;
    }
    tip = [x, y];
    context.lineTo(x, y);
    remaining -= length;
  }
  context.stroke();
  return tip;
}

function writeLabel(
  context: CanvasRenderingContext2D,
  element: ExcalidrawTextElement,
  lines: string[][],
  progress: number,
): Point {
  const { fontSize, fontFamily, lineHeight, textAlign, width } = element;
  const font = FONTS.get(fontFamily) ?? 'Helvetica';
  context.font = `${fontSize}px "${font}", Xiaolai, sans-serif`;
  context.textBaseline = 'alphabetic';
  let remaining = progress * lines.reduce((count, line) => count + line.length + 1, -1);
  let tip: Point = [0, fontSize];
  for (const [index, line] of lines.entries()) {
    const term = line.join('');
    const textWidth = context.measureText(term).width;
    const x = textAlign === 'center' ? (width - textWidth) / 2 : textAlign === 'right' ? width - textWidth : 0;
    const y = (index * lineHeight + .88) * fontSize;
    const count = Math.floor(remaining);
    const written = line.slice(0, count).join('');
    context.fillText(written, x, y);
    const writtenWidth = context.measureText(written).width;
    tip = [x + writtenWidth, y];
    if (remaining <= line.length) {
      const nextWidth = context.measureText(line[count] ?? '').width;
      return [tip[0] + nextWidth * (remaining - count), y];
    }
    remaining -= line.length + 1;
    if (remaining < 0) break;
  }
  return tip;
}

function inkStep(element: ExcalidrawElement, index: number) {
  if (element.type === 'text') {
    const lines = element.text.split('\n').map(line => Array.from(SEGMENTER.segment(line), part => part.segment));
    return {
      index, element, weight: Math.min(3.5, 1 + element.text.length / 24),
      draw: (context: CanvasRenderingContext2D, progress: number) => writeLabel(context, element, lines, progress),
    };
  }
  const points = outline(element);
  return {
    index, element,
    weight: Math.min(2.5, Math.max(.22, (element.width + element.height) / 155)),
    draw: (context: CanvasRenderingContext2D, progress: number) => drawOutline(context, points, progress),
  };
}

export function CanvasPlayback({ api, elements, timing }: {
  api: ExcalidrawImperativeAPI;
  elements: readonly ExcalidrawElement[];
  timing: NonNullable<ExtensionCanvasSnapshot['playback']>;
}) {
  const overlay = useRef<HTMLCanvasElement>(null);
  const pen = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const canvas = overlay.current;
    const cursor = pen.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !cursor || !context) {
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const start = performance.now() + Math.min(600, timing.startAt - Date.now());
    const visible = new Set(elements.slice(0, timing.firstElement).map((_, index) => index));
    const steps = elements.slice(timing.firstElement).flatMap((element, index) => {
      const position = timing.firstElement + index;
      if (element.isDeleted) {
        visible.add(position);
        return [];
      }
      return [inkStep(element, position)];
    });
    const totalWeight = steps.reduce((total, step) => total + step.weight, 0);
    let index = 0;
    let finishedWeight = 0;
    let animation = 0;

    function render(frameTime: number) {
      if (!canvas || !cursor || !context) return;
      const fraction = motion.matches ? 1 : Math.min(1, Math.max(0, (frameTime - start) / timing.durationMs));
      const target = fraction * totalWeight;
      let changed = false;
      while (index < steps.length && (fraction === 1 || finishedWeight + steps[index].weight <= target)) {
        const step = steps[index++];
        finishedWeight += step.weight;
        visible.add(step.index);
        changed = true;
      }
      if (changed) {
        api.updateScene({
          elements: elements.filter((_, position) => visible.has(position)), captureUpdate: CaptureUpdateAction.NEVER,
        });
      }

      const bounds = canvas.getBoundingClientRect();
      const scale = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(bounds.width * scale);
      const height = Math.round(bounds.height * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.resetTransform();
      context.clearRect(0, 0, width, height);
      const step = steps[index];
      if (!step) {
        cursor.hidden = true;
        return;
      }

      if (frameTime >= start) {
        const { element } = step;
        const { scrollX, scrollY, zoom: { value: zoom } } = api.getAppState();
        // The overlay shares the editor's local origin. Window offsets can lag during sidebar transitions.
        context.translate((element.x + scrollX) * zoom * scale, (element.y + scrollY) * zoom * scale);
        context.scale(zoom * scale, zoom * scale);
        context.translate(element.width / 2, element.height / 2);
        context.rotate(element.angle);
        context.translate(-element.width / 2, -element.height / 2);
        const ink = element.strokeColor === 'transparent' ? '#767581' : element.strokeColor;
        context.strokeStyle = ink;
        context.fillStyle = ink;
        context.lineWidth = Math.max(element.strokeWidth, 1 / zoom);
        context.globalAlpha = element.opacity / 100;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.setLineDash(element.strokeStyle === 'dashed' ? [8, 5] : element.strokeStyle === 'dotted' ? [1, 5] : []);
        const [x, y] = step.draw(context, (target - finishedWeight) / step.weight);
        const tip = context.getTransform().transformPoint({ x, y });
        cursor.style.transform = `translate3d(${tip.x / scale}px, ${tip.y / scale}px, 0)`;
        cursor.dataset.elementType = element.type;
        cursor.hidden = false;
      }
      animation = requestAnimationFrame(render);
    }
    animation = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animation);
  }, [api, elements, timing]);

  return <div className="extension-canvas-playback" aria-hidden="true">
    <canvas ref={overlay} className="extension-canvas-ink" />
    <span ref={pen} className="extension-canvas-pen" hidden><Pencil size={22} /></span>
  </div>;
}
