// Does not move hardware. Use only with a separate test device.
const base=process.env.SERVER_URL||'http://localhost:3000', token=process.env.DEVICE_TOKEN;
if(!token){console.error('Set DEVICE_TOKEN to a separate test device token first.');process.exit(1);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function post(endpoint,body){const r=await fetch(base+'/api/device/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
console.log('SIMULATOR — no hardware / no real food. Stop with Ctrl+C.');
let ack=null, applied=null;
while(true){
  try{
    if(ack){await post('ack',ack);ack=null;}
    else{
      const {command:c,config}=await post('poll',{protocol:4,applied_config:applied});
      if(config&&JSON.stringify(config)!==JSON.stringify(applied)){
        applied=config;console.log(`Simulated config v${config.version}: ${config.portions} portions, runtime/portion ${config.portion_ms} ms (RAM only)`);
      }
      if(c){console.log(`Simulating command ${c.id}: ${c.portions} portions, ${c.run_ms} ms total`);await sleep(c.run_ms);ack={id:c.id,status:'completed'};}
    }
  }catch(e){console.error(e.message);}
  await sleep(2000);
}
