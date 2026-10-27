import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const size = 128;
const pixels = Buffer.alloc((size * 4 + 1) * size);
const line = (x,y,ax,ay,bx,by,w) => {
 const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));
 return Math.hypot(x-ax-t*dx,y-ay-t*dy)<=w/2;
};
for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
 let color=[23,41,67,255];
 const corner=Math.hypot(Math.max(0,18-x,x-109),Math.max(0,18-y,y-109));
 if(corner>18) color=[0,0,0,0];
 if(line(x,y,25,36,87,36,7)||line(x,y,25,62,61,62,7)||line(x,y,25,88,48,88,7)) color=[134,173,255,255];
 const circle=Math.hypot(x-85,y-85);
 if(Math.abs(circle-24)<3.3||line(x,y,85,71,85,85,5)||line(x,y,85,85,97,92,5)) color=[236,244,255,255];
 const offset=y*(size*4+1)+1+x*4;
 for(let channel=0;channel<4;channel++)pixels[offset+channel]=color[channel];
}
const crc = data => { let n=0xffffffff; for(const byte of data){n^=byte;for(let bit=0;bit<8;bit++)n=n&1?0xedb88320^(n>>>1):n>>>1;}return(n^0xffffffff)>>>0;};
const chunk = (name,data) => {const type=Buffer.from(name),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([len,type,data,sum]);};
const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
await writeFile('media/icon.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
