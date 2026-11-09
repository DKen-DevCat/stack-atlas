// 手書きの型（types.ts）と JSON Schema（正）のずれを検出する（docs/08 D6）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CACHE_TONES,
  FLOW_TONES,
  KNOWN_EDGE_KINDS,
  KNOWN_NODE_KINDS,
  SCREEN_SOURCES_V1,
} from './types.js';
import { SCREEN_SOURCES } from './v2.js';

interface SchemaJson {
  required: string[];
  properties: Record<string, unknown>;
  $defs: Record<
    string,
    {
      required?: string[];
      properties: Record<string, { anyOf?: { enum?: string[] }[]; enum?: string[] }>;
    }
  >;
}

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../graph.schema.json', import.meta.url)), 'utf8'),
) as SchemaJson;

const enumOfAnyOf = (p: { anyOf?: { enum?: string[] }[] } | undefined) =>
  p?.anyOf?.find((a) => a.enum)?.enum;

describe('types.ts と graph.schema.json の一致', () => {
  it('KNOWN_NODE_KINDS = schema の node.kind enum', () => {
    expect([...KNOWN_NODE_KINDS].sort()).toEqual(
      [...enumOfAnyOf(schema.$defs.node!.properties.kind)!].sort(),
    );
  });

  it('KNOWN_EDGE_KINDS = schema の edge.kind enum', () => {
    expect([...KNOWN_EDGE_KINDS].sort()).toEqual(
      [...enumOfAnyOf(schema.$defs.edge!.properties.kind)!].sort(),
    );
  });

  it('CacheTone / FlowTone = schema の enum', () => {
    expect([...CACHE_TONES].sort()).toEqual([...schema.$defs.cache!.properties.tone!.enum!].sort());
    expect([...FLOW_TONES].sort()).toEqual([...schema.$defs.flow!.properties.tone!.enum!].sort());
  });

  it('トップレベルのフィールドが想定どおり', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['$schema', 'version', 'project', 'layers', 'nodes', 'edges', 'flows', 'kinds'].sort(),
    );
    expect(schema.required.sort()).toEqual(['edges', 'layers', 'nodes', 'version']);
  });

  it('screen のフィールドと source の enum（8-3b で html / source を足した。v2 の screen と同じ語彙）', () => {
    const screen = schema.$defs.screen!;
    expect(Object.keys(screen.properties).sort()).toEqual(
      ['html', 'source', 'screenshot', 'width', 'height', 'regions'].sort(),
    );
    expect([...SCREEN_SOURCES_V1].sort()).toEqual([...screen.properties.source!.enum!].sort());
    // upgradeGraph が screen をそのまま写すので、v1 と v2 の語彙は同じでなければならない
    expect([...SCREEN_SOURCES_V1].sort()).toEqual([...SCREEN_SOURCES].sort());
  });

  it('kinds の定義のフィールドが想定どおり', () => {
    expect(Object.keys(schema.$defs.kindDefinition!.properties).sort()).toEqual(
      ['name', 'color', 'size', 'layer'].sort(),
    );
  });

  it('ノード・エッジのフィールドが想定どおり', () => {
    expect(Object.keys(schema.$defs.node!.properties).sort()).toEqual(
      [
        'id',
        'layer',
        'kind',
        'name',
        'file',
        'line',
        'code',
        'position',
        'cache',
        'screen',
        'meta',
      ].sort(),
    );
    expect(Object.keys(schema.$defs.edge!.properties).sort()).toEqual(
      ['from', 'to', 'kind', 'label'].sort(),
    );
  });
});
