import { z } from 'zod';

const labelSchema = z.object({ x: z.number(), text: z.string(), price: z.number() });
const lineSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  y2: z.number(),
  style: z.string().nullable(),
});

const studySchema = z.object({
  name: z.string(),
  labels: z.array(labelSchema),
  lines: z.array(lineSchema),
});

const snapshotSchema = z.object({
  symbol: z.string().nullable(),
  resolution: z.string().nullable(),
  study: studySchema.nullable(),
  error: z.string().optional(),
});

export type StudySnapshot = z.infer<typeof studySchema>;
export type ChartSnapshot = z.infer<typeof snapshotSchema>;

/** Runs a JavaScript expression inside the TradingView chart page and returns its value. */
export type Evaluate = (expression: string) => Promise<unknown>;

/**
 * Expression that reads the chart symbol, timeframe and the drawings (labels and lines) of one
 * indicator. It uses TradingView's internal chart model, the same one the TradingView MCP reads,
 * so it can break when TradingView changes its internals. The study name is passed through
 * JSON.stringify so it can never alter the script.
 */
export function buildReadExpression(studyName: string): string {
  return `(function (studyName) {
    var out = { symbol: null, resolution: null, study: null };
    try {
      var widget = window.TradingViewApi._activeChartWidgetWV.value();
      out.symbol = String(widget.symbol());
      out.resolution = String(widget.resolution());
      var sources = widget._chartWidget.model().model().dataSources();
      var read = function (outer, key) {
        var items = [];
        try {
          var inner = outer && outer.get(key);
          var coll = inner && inner.get(false);
          if (coll && coll._primitivesDataById) {
            coll._primitivesDataById.forEach(function (v) { items.push(v); });
          }
        } catch (e) {}
        return items;
      };
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (name !== studyName) continue;
        var pc = s._graphics && s._graphics._primitivesCollection;
        if (!pc) continue;
        var labels = read(pc.dwglabels, 'labels')
          .filter(function (v) { return typeof v.y === 'number' && typeof v.x === 'number'; })
          .map(function (v) { return { x: v.x, text: v.t || '', price: v.y }; });
        var lines = read(pc.dwglines, 'lines')
          .filter(function (v) { return typeof v.y1 === 'number' && typeof v.y2 === 'number' && typeof v.x1 === 'number'; })
          .map(function (v) { return { x1: v.x1, y1: v.y1, y2: v.y2, style: v.st == null ? null : String(v.st) }; });
        out.study = { name: name, labels: labels, lines: lines };
        break;
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  })(${JSON.stringify(studyName)})`;
}

export async function readChart(evaluate: Evaluate, studyName: string): Promise<ChartSnapshot> {
  const raw = await evaluate(buildReadExpression(studyName));
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('unexpected reply from the TradingView page (its internals may have changed)');
  }
  return parsed.data;
}
