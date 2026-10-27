import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
await build({entryPoints:['src/shared/demo.ts'],outfile:'artifacts/demo.mjs',bundle:true,platform:'node',format:'esm'});
const { createDemoSnapshot } = await import(pathToFileURL(process.cwd()+'/artifacts/demo.mjs').href);
const snapshot=createDemoSnapshot('demo-user');
const state={repository:snapshot.repository,account:'demo-user',snapshot,loading:false,error:null,retryAt:null,
 filters:{resource:null,mine:false,search:'',tab:'queued',pr:null},autoRefresh:true,refreshIntervalSeconds:120,locale:'zh-cn',discoveryWarnings:[]};
const bridge=`let state=${JSON.stringify(state).replaceAll('<','\\u003c')};
const deliver=()=>window.postMessage({type:'state',state},location.origin);
window.acquireVsCodeApi=()=>({postMessage(message){
 if(message.type==='ready')deliver();
 if(message.type==='setFilters'){state.filters=message.filters;deliver();}
 if(message.type==='refresh'){state.loading=true;deliver();setTimeout(()=>{state.loading=false;deliver()},4000);}
 if(message.type==='openExternal')console.info('GitHub link:',message.url);
}});`;
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TileLang CI · DEMO preview</title><link rel="stylesheet" href="/webview.css"></head><body class="vscode-dark"><div id="root"></div><script>${bridge}</script><script src="/webview.js"></script></body></html>`;
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
  const resources={'/webview.js':['dist/webview.js','text/javascript'],'/webview.css':['dist/webview.css','text/css']};
  const asset=resources[req.url];if(!asset){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(await readFile(asset[0]));
 }catch{res.writeHead(500);res.end('Build the extension first.');}
});
server.listen(4178,'127.0.0.1',()=>console.log('TileLang CI offline DEMO preview: http://127.0.0.1:4178'));
