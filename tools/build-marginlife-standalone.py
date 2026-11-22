#!/usr/bin/env python3
"""Create a single-file MARGINLIFE P2 demo with source modules inlined.

No network dependencies. The source application uses regular relative imports; this
export is for opening the demo from a downloaded HTML file. It uses JS backend.
"""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
game=root/'games'/'marginlife'
html=(game/'index.html').read_text('utf-8')
style=(game/'style.css').read_text('utf-8')
world=json.loads((game/'world.json').read_text('utf-8'))
rng=(root/'src'/'core'/'rng.js').read_text('utf-8')
hash_js=(root/'src'/'core'/'state-hash.js').read_text('utf-8')
loader=(root/'src'/'render'/'sim-loader.js').read_text('utf-8')
sim=(game/'sim.js').read_text('utf-8')
ui=(game/'ui.js').read_text('utf-8')

def one(s,old,new='',where='unknown'):
    n=s.count(old)
    if n!=1:raise RuntimeError(f'{where}: expected one occurrence, got {n}: {old[:60]}')
    return s.replace(old,new,1)

rng=rng.replace('export class Rng','class Rng')
hash_js=hash_js.replace('export function stateHash','function stateHash')
loader=one(loader,'import { Rng } from "../core/rng.js";\n','', 'loader')
loader=one(loader,'import { stateHash } from "../core/state-hash.js";\n','', 'loader')
loader=one(loader,'export async function createSim','async function createSim','loader')
sim=one(sim,'import { Rng } from "../../src/core/rng.js";\n','', 'sim')
sim=one(sim,'import { stateHash } from "../../src/core/state-hash.js";\n','', 'sim')
sim=sim.replace('export const ','const ').replace('export function ','function ')
ui=one(ui,'import { createSim } from "../../src/render/sim-loader.js";\n','', 'ui')
ui=one(ui,'import { createInitialState, step, GAME_KIND, DEFAULT_SEED, PHASES } from "./sim.js";\n','', 'ui')
ui=one(ui,'''const WORLD = await fetch("./world.json").then(r => {
  if (!r.ok) throw new Error(`world.json could not load (${r.status})`);
  return r.json();
});''', 'const WORLD = '+json.dumps(world,ensure_ascii=False,separators=(',',':'))+';', 'world embed')
source='\n\n'.join([rng,hash_js,loader,sim,ui])
if '</script' in source.lower():raise ValueError('script-breaking tag found')
html=one(html,'<link rel="stylesheet" href="./style.css">','<style>\n'+style+'\n</style>','css inline')
html=one(html,'<script type="module" src="./ui.js"></script>','<script type="module">\n'+source+'\n</script>','js inline')
out=Path(__file__).resolve().parents[2]/'MARGINLIFE_P2_Playable_Standalone.html'
out.write_text(html,'utf-8')
print(json.dumps({'output':str(out),'bytes':out.stat().st_size,'inline_javascript':len(source)},ensure_ascii=False))
