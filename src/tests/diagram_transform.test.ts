import { describe, it, expect } from 'vitest';
import {
  clampScale,
  zoomAtPoint,
  pan,
  fitToView,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_FACTOR,
  PAN_STEP,
  type DiagramTransform,
} from '$lib/diagramTransform';

describe('diagramTransform', () => {
  describe('clampScale', () => {
    it('clamps below minimum', () => {
      expect(clampScale(0.1)).toBe(ZOOM_MIN);
    });
    it('clamps above maximum', () => {
      expect(clampScale(10)).toBe(ZOOM_MAX);
    });
    it('passes through values in range', () => {
      expect(clampScale(1.5)).toBe(1.5);
    });
    it('clamps exactly at boundaries', () => {
      expect(clampScale(ZOOM_MIN)).toBe(ZOOM_MIN);
      expect(clampScale(ZOOM_MAX)).toBe(ZOOM_MAX);
    });
  });

  describe('pan', () => {
    it('adds dx and dy to current pan', () => {
      const t: DiagramTransform = { scale: 1, panX: 10, panY: 20 };
      const result = pan(t, 50, -30);
      expect(result).toEqual({ scale: 1, panX: 60, panY: -10 });
    });
    it('preserves scale', () => {
      const t: DiagramTransform = { scale: 2.5, panX: 0, panY: 0 };
      const result = pan(t, PAN_STEP, 0);
      expect(result.scale).toBe(2.5);
    });
  });

  describe('zoomAtPoint', () => {
    it('zooms in by ZOOM_FACTOR', () => {
      const t: DiagramTransform = { scale: 1, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, 1, 0, 0);
      expect(result.scale).toBeCloseTo(ZOOM_FACTOR);
    });
    it('zooms out by 1/ZOOM_FACTOR', () => {
      const t: DiagramTransform = { scale: 1, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, -1, 0, 0);
      expect(result.scale).toBeCloseTo(1 / ZOOM_FACTOR);
    });
    it('clamps zoom to max', () => {
      const t: DiagramTransform = { scale: ZOOM_MAX, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, 1, 100, 100);
      expect(result.scale).toBe(ZOOM_MAX);
    });
    it('clamps zoom to min', () => {
      const t: DiagramTransform = { scale: ZOOM_MIN, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, -1, 100, 100);
      expect(result.scale).toBe(ZOOM_MIN);
    });
    it('keeps the cursor point stable after zoom', () => {
      const cursorX = 200, cursorY = 150;
      const t: DiagramTransform = { scale: 1, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, 1, cursorX, cursorY);
      const canvasBefore = (cursorX - t.panX) / t.scale;
      const canvasAfter = (cursorX - result.panX) / result.scale;
      expect(canvasAfter).toBeCloseTo(canvasBefore);
    });
  });

  describe('fitToView', () => {
    it('scales landscape SVG to fit viewport width', () => {
      const result = fitToView(800, 200, 400, 300);
      expect(result.scale).toBeCloseTo(0.5);
    });
    it('scales portrait SVG to fit viewport height', () => {
      const result = fitToView(200, 800, 400, 300);
      expect(result.scale).toBeCloseTo(0.375);
    });
    it('scales square SVG to fit smaller viewport dimension', () => {
      const result = fitToView(500, 500, 400, 300);
      expect(result.scale).toBeCloseTo(0.6); // 300/500
    });
    it('caps upscaling at 2.0', () => {
      const result = fitToView(100, 50, 800, 600);
      expect(result.scale).toBe(2.0);
    });
    it('centers the SVG in the viewport', () => {
      const result = fitToView(800, 200, 400, 300);
      expect(result.panX).toBeCloseTo(0);
      expect(result.panY).toBeCloseTo(100);
    });
    it('handles zero-size SVG gracefully', () => {
      const result = fitToView(0, 0, 400, 300);
      expect(result.scale).toBe(1.0);
      expect(result.panX).toBe(0);
      expect(result.panY).toBe(0);
    });
  });
});
