// graph.json をスキーマ検証＋参照整合性チェックする
// 使い方: npm i ajv ajv-formats && node scripts/validate-graph.mjs schema/graph.schema.json examples/race-site.graph.json
import Ajv from 'ajv/dist/2020.js'; import addFormats from 'ajv-formats'; import {readFileSync} from 'fs';
const ajv=new Ajv({allErrors:true,strict:false}); addFormats(ajv);
const v=ajv.compile(JSON.parse(readFileSync(process.argv[2])));
const g=JSON.parse(readFileSync(process.argv[3]));
console.log('schema valid:',v(g), v.errors?.slice(0,5));
const ids=new Set(g.nodes.map(n=>n.id)), L=new Set(g.layers.map(l=>l.id)); const bad=[];
g.nodes.forEach(n=>{if(!L.has(n.layer))bad.push('layer '+n.id); n.screen?.regions?.forEach(r=>{if(!ids.has(r.ref))bad.push('region '+r.ref)})});
g.edges.forEach(e=>{if(!ids.has(e.from)||!ids.has(e.to))bad.push('edge '+e.from+'>'+e.to)});
g.flows.forEach(f=>f.steps.forEach(s=>{if(!ids.has(s.node))bad.push('flow '+s.node)}));
console.log('ref errors:',bad);
