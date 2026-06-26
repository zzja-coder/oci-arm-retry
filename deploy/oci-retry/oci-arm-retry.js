// Reintentos automáticos hasta que Oracle libere capacidad ARM.
//
// Lee la config desde ~/.oci/config (formato estándar de oci-cli) y un .env
// con los datos específicos de la instancia que queremos crear.
//
// Reintenta cada 60s en TODAS las availability domains de la región.
// Cuando una entra, imprime el OCID de la instancia y la IP pública.

import { config as dotenvConfig } from 'dotenv';
import * as common from 'oci-common';
import * as core from 'oci-core';
import * as identity from 'oci-identity';

dotenvConfig();

// --- Config ---
const COMPARTMENT_ID = process.env.COMPARTMENT_ID;
const SUBNET_ID = process.env.SUBNET_ID;
const SSH_PUBLIC_KEY = process.env.SSH_PUBLIC_KEY;
const OCPUS = Number(process.env.OCPUS || 4);
const MEMORY_GB = Number(process.env.MEMORY_GB || 24);
const DISPLAY_NAME = process.env.DISPLAY_NAME || 'agente-conti';
const SHAPE = 'VM.Standard.A1.Flex';
const RETRY_INTERVAL_MS = 60_000;
// Si LOOP_FOREVER=false (modo GH Actions con cron), prueba una vez y sale.
// Si está sin setear o true (modo local), reintenta para siempre.
const LOOP_FOREVER = process.env.LOOP_FOREVER !== 'false';

for (const [k, v] of Object.entries({ COMPARTMENT_ID, SUBNET_ID, SSH_PUBLIC_KEY })) {
  if (!v) {
    console.error(`✗ Falta ${k} en .env`);
    process.exit(1);
  }
}

// --- Clientes OCI ---
const provider = new common.ConfigFileAuthenticationDetailsProvider();
const compute = new core.ComputeClient({ authenticationDetailsProvider: provider });
const idClient = new identity.IdentityClient({ authenticationDetailsProvider: provider });

// --- Auto-discovery: image OCID + availability domains ---
async function discover() {
  console.log('🔍 Descubriendo image OCID (Ubuntu 22.04 ARM más reciente)...');
  const imgRes = await compute.listImages({
    compartmentId: COMPARTMENT_ID,
    operatingSystem: 'Canonical Ubuntu',
    operatingSystemVersion: '22.04',
    shape: SHAPE,
    sortBy: core.requests.ListImagesRequest.SortBy.Timecreated,
    sortOrder: core.requests.ListImagesRequest.SortOrder.Desc,
    limit: 5,
  });
  const image = imgRes.items.find(i => i.displayName?.toLowerCase().includes('aarch64'))
            || imgRes.items[0];
  if (!image) throw new Error('No encontré imagen Ubuntu 22.04 ARM en este compartment');
  console.log(`   ✓ ${image.displayName}`);
  console.log(`     ${image.id}`);

  console.log('🔍 Descubriendo availability domains...');
  const adRes = await idClient.listAvailabilityDomains({ compartmentId: COMPARTMENT_ID });
  const ads = adRes.items.map(a => a.name);
  console.log(`   ✓ ${ads.length} AD(s): ${ads.join(', ')}`);

  return { imageId: image.id, ads };
}

// --- Intentar crear la VM en una AD ---
async function tryLaunch(imageId, ad) {
  const launchDetails = {
    availabilityDomain: ad,
    compartmentId: COMPARTMENT_ID,
    shape: SHAPE,
    shapeConfig: { ocpus: OCPUS, memoryInGBs: MEMORY_GB },
    displayName: DISPLAY_NAME,
    metadata: { ssh_authorized_keys: SSH_PUBLIC_KEY.trim() },
    sourceDetails: {
      sourceType: 'image',
      imageId: imageId,
    },
    createVnicDetails: {
      subnetId: SUBNET_ID,
      assignPublicIp: true,
    },
    agentConfig: {
      isMonitoringDisabled: false,
      isManagementDisabled: false,
    },
  };
  return compute.launchInstance({ launchInstanceDetails: launchDetails });
}

// --- Wait for VM Running + get IP ---
async function getPublicIp(instanceId) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const vnics = await compute.listVnicAttachments({
        compartmentId: COMPARTMENT_ID,
        instanceId,
      });
      if (vnics.items.length > 0) {
        const vnicId = vnics.items[0].vnicId;
        const net = new core.VirtualNetworkClient({ authenticationDetailsProvider: provider });
        const vnic = await net.getVnic({ vnicId });
        if (vnic.vnic.publicIp) return vnic.vnic.publicIp;
      }
    } catch {}
  }
  return null;
}

// --- Loop principal ---
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  OCI ARM CAPACITY RETRY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Shape:        ${SHAPE}`);
  console.log(`OCPUs:        ${OCPUS}`);
  console.log(`Memory:       ${MEMORY_GB} GB`);
  console.log(`Display name: ${DISPLAY_NAME}`);
  console.log(`Subnet:       ${SUBNET_ID.slice(0, 60)}...`);
  console.log('');

  const { imageId, ads } = await discover();
  console.log('');
  if (LOOP_FOREVER) {
    console.log(`🔁 Reintentando cada ${RETRY_INTERVAL_MS / 1000}s. Dejá la ventana abierta.`);
    console.log('   (Ctrl+C para cortar.)');
  } else {
    console.log('🎯 Modo single-shot (GitHub Actions): un intento y salir.');
  }
  console.log('');

  let attempt = 0;
  do {
    attempt++;
    for (const ad of ads) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      process.stdout.write(`[${ts}] Intento #${attempt} en ${ad}... `);
      try {
        const res = await tryLaunch(imageId, ad);
        const instanceId = res.instance.id;
        console.log('🎉 CAPACIDAD CONSEGUIDA!');
        console.log('');
        console.log(`Instance OCID: ${instanceId}`);
        console.log(`Esperando IP pública...`);
        const ip = await getPublicIp(instanceId);
        if (ip) {
          console.log('');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`  ✓ VM LISTA — IP PÚBLICA: ${ip}`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('');
          console.log('Próximo paso: SSH con tu key:');
          console.log(`  ssh -i %USERPROFILE%\\.ssh\\agente_conti ubuntu@${ip}`);
        } else {
          console.log('  ⚠ La VM se creó pero no pude obtener la IP. Mirá en la consola.');
        }
        process.exit(0);
      } catch (err) {
        const code = err.statusCode || err.serviceCode || 'unknown';
        const msg = (err.message || '').slice(0, 120);
        if (msg.toLowerCase().includes('out of capacity') ||
            msg.toLowerCase().includes('insufficient') ||
            code === 500) {
          console.log('sin capacidad');
        } else if (code === 429 || msg.toLowerCase().includes('too many')) {
          console.log('rate-limit (esperando más)');
          await new Promise(r => setTimeout(r, 30_000));
        } else {
          console.log(`ERROR ${code}: ${msg}`);
          if (code === 401 || code === 403) {
            console.error('   → Problema de auth. Revisá ~/.oci/config y el .pem.');
            process.exit(1);
          }
        }
      }
    }
    if (LOOP_FOREVER) {
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
    }
  } while (LOOP_FOREVER);

  // Si llegamos acá en modo single-shot, no hubo capacidad esta vez.
  console.log('');
  console.log('Esta vez no entró. GitHub Actions vuelve a probar en 5 min.');
  process.exit(1);
}

main().catch(err => {
  console.error('');
  console.error('FATAL:', err.message || err);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
