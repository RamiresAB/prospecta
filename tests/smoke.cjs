const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const page=fs.readFileSync('Prospecta.html','utf8');
const scripts=Array.from(page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).map(m=>m[1]);
assert(scripts.length>0);for(const code of scripts)new vm.Script(code);
assert(page.includes('localStorage'));assert(page.includes('demo:true'));
const server=fs.readFileSync('iniciar-prospecta.js','utf8');assert(server.includes("server.listen(PORT, '127.0.0.1'"));
console.log('PASS: JavaScript do painel válido, exemplos fictícios e serviço restrito a loopback.');
