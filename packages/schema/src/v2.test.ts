// 手書きの型（v2.ts）と JSON Schema（graph-v2.schema.json。正）のずれを検出する
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGION_SOURCES } from './types.js';
import {
  BROKEN_LEVELS,
  CHECKED_STATUSES,
  CONFIDENCES,
  NODE_KINDS_V2,
  PORT_DIRS,
  RUNTIMES,
  SCREEN_SOURCES,
  WIRE_TYPES,
  WIRE_VIAS,
  parseItemRef,
  parseLocalRef,
  parseWhenKey,
  wireTypeCompatible,
  wireTypeMatch,
} from './v2.js';

interface Def {
  required?: string[];
  properties: Record<string, { enum?: string[]; $ref?: string }>;
}
interface SchemaJson {
  required: string[];
  properties: Record<string, unknown>;
  $defs: Record<string, Def & { enum?: string[] }>;
}

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../graph-v2.schema.json', import.meta.url)), 'utf8'),
) as SchemaJson;

const sorted = (xs: readonly string[]) => [...xs].sort();
const keys = (def: Def) => sorted(Object.keys(def.properties));

describe('v2.ts と graph-v2.schema.json の一致', () => {
  it('列挙（kind / runtime / via / wireType / dir / confidence / broken.level / screen.source）', () => {
    expect(sorted(NODE_KINDS_V2)).toEqual(sorted(schema.$defs.node!.properties.kind!.enum!));
    expect(sorted(RUNTIMES)).toEqual(sorted(schema.$defs.node!.properties.runtime!.enum!));
    expect(sorted(WIRE_VIAS)).toEqual(sorted(schema.$defs.wire!.properties.via!.enum!));
    expect(sorted(WIRE_TYPES)).toEqual(sorted(schema.$defs.item!.properties.wireType!.enum!));
    expect(sorted(PORT_DIRS)).toEqual(sorted(schema.$defs.port!.properties.dir!.enum!));
    expect(sorted(CONFIDENCES)).toEqual(sorted(schema.$defs.confidence!.enum!));
    expect(sorted(BROKEN_LEVELS)).toEqual(sorted(schema.$defs.broken!.properties.level!.enum!));
    expect(sorted(SCREEN_SOURCES)).toEqual(sorted(schema.$defs.screen!.properties.source!.enum!));
  });

  it('トップレベルのフィールド', () => {
    expect(sorted(Object.keys(schema.properties))).toEqual(
      sorted(['$schema', 'version', 'project', 'types', 'nodes', 'wires', 'views']),
    );
    expect(sorted(schema.required)).toEqual(['nodes', 'version', 'wires']);
  });

  it('箱・口・項目・線・links・分岐・view・型・broken のフィールド（NodeV2 などの型と同じ）', () => {
    expect(keys(schema.$defs.node!)).toEqual(
      sorted([
        'id',
        'kind',
        'name',
        'runtime',
        'file',
        'line',
        'code',
        'host',
        'group',
        'ports',
        'links',
        'variants',
        'cache',
        'screen',
        'position',
        'meta',
      ]),
    );
    expect(sorted(schema.$defs.node!.required!)).toEqual([
      'id',
      'kind',
      'name',
      'ports',
      'runtime',
    ]);
    expect(keys(schema.$defs.port!)).toEqual(sorted(['id', 'dir', 'name', 'items']));
    expect(keys(schema.$defs.item!)).toEqual(
      sorted([
        'id',
        'name',
        'type',
        'wireType',
        'nullable',
        'optional',
        'typeRef',
        'children',
        'when',
        'confidence',
        'meta',
      ]),
    );
    expect(sorted(schema.$defs.item!.required!)).toEqual(['id', 'name', 'type']);
    expect(keys(schema.$defs.wire!)).toEqual(
      sorted(['from', 'to', 'via', 'reply', 'when', 'broken', 'label', 'route', 'meta']),
    );
    expect(sorted(schema.$defs.wire!.required!)).toEqual(['from', 'to', 'via']);
    // 2026-11-09 変更（8-4）: links に meta（補いの出どころ by・reason。docs/19 §3.1）
    expect(keys(schema.$defs.link!)).toEqual(sorted(['from', 'to', 'when', 'confidence', 'meta']));
    expect(keys(schema.$defs.variant!)).toEqual(sorted(['id', 'name', 'default']));
    expect(keys(schema.$defs.view!)).toEqual(
      sorted(['id', 'name', 'description', 'start', 'variants']),
    );
    expect(keys(schema.$defs.namedType!)).toEqual(
      sorted(['id', 'name', 'file', 'line', 'source', 'meta']),
    );
    expect(keys(schema.$defs.broken!)).toEqual(sorted(['path', 'level', 'reason']));
    expect(keys(schema.$defs.screen!)).toEqual(
      sorted(['html', 'source', 'screenshot', 'width', 'height', 'regions']),
    );
  });

  it('regions の source と project.generator.report（8-4。docs/19 §3.2・§3.7）', () => {
    const screen = schema.$defs.screen! as unknown as {
      properties: { regions: { items: Def & { properties: Def['properties'] } } };
    };
    const region = screen.properties.regions.items;
    expect(keys(region)).toEqual(sorted(['ref', 'x', 'y', 'w', 'h', 'source']));
    expect(sorted(region.properties.source!.enum!)).toEqual(sorted(REGION_SOURCES));
    const report = schema.$defs.report! as unknown as Def & {
      properties: { checked: { additionalProperties: Def } };
    };
    expect(keys(report)).toEqual(sorted(['version', 'checked', 'counts', 'lists']));
    expect(sorted(report.required!)).toEqual(['checked', 'counts', 'version']);
    const checked = report.properties.checked.additionalProperties;
    expect(keys(checked)).toEqual(sorted(['status', 'role', 'reason']));
    expect(sorted(checked.properties.status!.enum!)).toEqual(sorted(CHECKED_STATUSES));
  });
});

describe('参照の切り方（D36）', () => {
  it('最初の # で箱、次の / で口、残りを . で項目', () => {
    expect(parseItemRef('endpoint:GET /today#res/body.entries.amount')).toEqual({
      nodeId: 'endpoint:GET /today',
      portId: 'res',
      path: ['body', 'entries', 'amount'],
    });
    expect(parseItemRef('fn:internal/api.handleToday#in/r')).toEqual({
      nodeId: 'fn:internal/api.handleToday',
      portId: 'in',
      path: ['r'],
    });
    expect(parseItemRef('fn:x')).toBeNull();
    expect(parseItemRef('fn:x#in')).toBeNull();
    expect(parseItemRef('fn:x#in/')).toBeNull();
    expect(parseLocalRef('in/rows.created_at')).toEqual({
      portId: 'in',
      path: ['rows', 'created_at'],
    });
    expect(parseLocalRef('rows')).toBeNull();
  });

  it('when のキーは最後の # で箱と分岐に分かれる', () => {
    expect(parseWhenKey('hit')).toEqual({ variantId: 'hit' });
    expect(parseWhenKey('screen:/today#login')).toEqual({
      nodeId: 'screen:/today',
      variantId: 'login',
    });
  });

  it('wireType の互換は包含（integer ⊂ number、datetime ⊂ string）。unknown は照合しない', () => {
    expect(wireTypeCompatible('integer', 'number')).toBe(true);
    expect(wireTypeCompatible('number', 'integer')).toBe(false);
    expect(wireTypeCompatible('datetime', 'string')).toBe(true);
    expect(wireTypeCompatible('string', 'datetime')).toBe(false);
    expect(wireTypeCompatible('object', 'array')).toBe(false);
    expect(wireTypeCompatible('unknown', 'array')).toBe(true);
    expect(wireTypeCompatible('array', 'unknown')).toBe(true);
  });

  it('合流点の照合（D46）: number → integer は warn、string → datetime は sql の境界だけ互換', () => {
    expect(wireTypeMatch('integer', 'number')).toBe('ok');
    expect(wireTypeMatch('number', 'integer')).toBe('warn');
    expect(wireTypeMatch('string', 'datetime', 'sql')).toBe('ok');
    expect(wireTypeMatch('string', 'datetime', 'http')).toBe('error');
    expect(wireTypeMatch('string', 'datetime')).toBe('error');
    expect(wireTypeMatch('object', 'array', 'sql')).toBe('error');
    expect(wireTypeMatch('unknown', 'integer')).toBe('ok');
  });
});
