import {build} from 'esbuild';
import {mkdir,copyFile,cp} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/app.jsx'],bundle:true,minify:true,outfile:'dist/app.js',define:{'process.env.NODE_ENV':'"production"'},legalComments:'linked'});
await copyFile('src/style.css','dist/style.css');
await copyFile('index.html','dist/index.html');
await cp('src/fonts','dist/fonts',{recursive:true});
await cp('../samples','dist/samples',{recursive:true});
