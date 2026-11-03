// Awaited, request-bound parser process. No queue, role, daemon or persisted job state.
import sharp from 'sharp';
import {PDFDocument,PDFDict,PDFArray,PDFName,PDFRawStream,PDFInvalidObject,decodePDFRawStream} from 'pdf-lib';
const policy=JSON.parse(process.argv[3]??'{}'),media=process.argv[2];
function fail(){throw new Error('Invalid file');}
const chunks=[];let total=0;
for await(const chunk of process.stdin){total+=chunk.length;if(total>10485760)fail();chunks.push(chunk);}
const bytes=Buffer.concat(chunks);if(!bytes.length)fail();
try{
 if(!policy.allowedTypes.includes(media)||bytes.length>policy.maxFileBytes)fail();
 if(/<(?:script|html|svg)\b/i.test(bytes.toString('latin1')))fail();
 if(media==='application/pdf'){
  if(!/^%PDF-(?:1\.[0-7]|2\.0)/.test(bytes.subarray(0,9).toString('ascii'))||!bytes.subarray(-1024).toString('latin1').match(/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/))fail();
  const pdf=await PDFDocument.load(bytes,{ignoreEncryption:false,throwOnInvalidObject:true,updateMetadata:false,capNumbers:true,parseSpeed:100});
  if(pdf.isEncrypted||pdf.getPageCount()<1||pdf.getPageCount()>policy.maxPdfPages)fail();
  const objects=pdf.context.enumerateIndirectObjects();if(objects.length>50000)fail();
  const forbidden=new Set(['JavaScript','JS','AA','OpenAction','Launch','EmbeddedFile','EmbeddedFiles','EF','Filespec','RichMedia','XFA','AcroForm','SubmitForm','ImportData','URI','GoToR','GoToE','Sound','Movie','Rendition']);
  const visited=new Set();let nodes=0,decoded=0;
  function inspect(object,depth=0){
   if(!object||visited.has(object))return;visited.add(object);if(++nodes>100000||depth>40||object instanceof PDFInvalidObject)fail();
   if(object instanceof PDFName&&forbidden.has(object.decodeText()))fail();
   if(object instanceof PDFRawStream){inspect(object.dict,depth+1);const filter=object.dict.get(PDFName.of('Filter'));if(filter instanceof PDFName&&filter.decodeText()==='DCTDecode'){const data=object.getContents();embeddedJpegs.push(Buffer.from(data));decoded+=data.length;}else{const data=decodePDFRawStream(object).decode();decoded+=data.length;}if(decoded>20*1024*1024)fail();}
   else if(object instanceof PDFDict){for(const [key,value]of object.entries()){if(key.decodeText()==='A'){const resolved=pdf.context.lookup(value);if(resolved instanceof PDFDict&&resolved.has(PDFName.of('S')))fail();}inspect(key,depth+1);inspect(value,depth+1);}}
   else if(object instanceof PDFArray){for(const value of object.asArray())inspect(value,depth+1);}
  }
  const embeddedJpegs=[];for(const [,object]of objects)inspect(object);
  for(const data of embeddedJpegs){const decoder=sharp(data,{limitInputPixels:policy.maxPixels,failOn:'warning'}),meta=await decoder.metadata();if(meta.format!=='jpeg'||!meta.width||!meta.height||meta.width>policy.maxDimension||meta.height>policy.maxDimension)fail();await decoder.raw().toBuffer();}
  for(const page of pdf.getPages()){const {width,height}=page.getSize();if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>20000||height>20000)fail();}
  process.stdout.write(JSON.stringify({media,pages:pdf.getPageCount()}));
 }else{
  if(media==='image/png'){
   if(!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))fail();let offset=8,header=false,end=false;
   function crc(data){let c=0xffffffff;for(const v of data){c^=v;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
   while(offset<bytes.length){if(offset+12>bytes.length)fail();const n=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(!/^[A-Za-z]{4}$/.test(type)||offset+n+12>bytes.length||crc(bytes.subarray(offset+4,offset+8+n))!==bytes.readUInt32BE(offset+8+n))fail();if(!header){if(type!=='IHDR'||n!==13)fail();header=true;}else if(type==='IHDR')fail();if(['acTL','fcTL','fdAT'].includes(type))fail();offset+=n+12;if(type==='IEND'){if(n!==0||offset!==bytes.length)fail();end=true;break;}}
   if(!header||!end)fail();
  }else if(media==='image/jpeg'){
   if(bytes[0]!==255||bytes[1]!==216)fail();let pos=2,entropy=false,end=false;
   while(pos<bytes.length){if(entropy){while(pos<bytes.length&&bytes[pos]!==255)pos++;if(pos>=bytes.length)fail();while(bytes[pos]===255)pos++;const m=bytes[pos];if(m===0||m>=208&&m<=215){pos++;continue;}pos--;entropy=false;}
    if(bytes[pos++]!==255)fail();while(bytes[pos]===255)pos++;const marker=bytes[pos++];if(marker===217){if(pos!==bytes.length)fail();end=true;break;}if(marker===216||marker===0)fail();if(marker===1||marker>=208&&marker<=215)continue;if(pos+2>bytes.length)fail();const len=bytes.readUInt16BE(pos);if(len<2||pos+len>bytes.length)fail();pos+=len;if(marker===218)entropy=true;
   }if(!end)fail();
  }else if(media==='image/webp'){
   if(bytes.length<20||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)fail();let pos=12;
   while(pos<bytes.length){if(pos+8>bytes.length)fail();const type=bytes.toString('ascii',pos,pos+4),n=bytes.readUInt32LE(pos+4);if(!['VP8 ','VP8L','VP8X','ALPH','ICCP','EXIF','XMP '].includes(type)||pos+8+n+(n%2)>bytes.length)fail();pos+=8+n+(n%2);}if(pos!==bytes.length)fail();
  }else fail();
  const image=sharp(bytes,{failOn:'warning',limitInputPixels:policy.maxPixels,animated:false});const info=await image.metadata();
  const expected={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'};
  if(info.format!==expected[media]||!info.width||!info.height||info.width>policy.maxDimension||info.height>policy.maxDimension||info.width*info.height>policy.maxPixels||(info.pages??1)>1)fail();
  await image.raw().toBuffer(); // Decode every pixel, not just metadata/signature.
  process.stdout.write(JSON.stringify({media,width:info.width,height:info.height}));
 }
}catch{process.stderr.write('Validation failed');process.exitCode=1;}
