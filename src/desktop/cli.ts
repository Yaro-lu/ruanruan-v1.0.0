import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadDesktopConfig } from './config.js';
import { createDesktopStore } from './store.js';
import { syncDesktopIdentities } from './identity.js';
import { createInterface } from 'node:readline';

// Local application interface used by the desktop MCP operator. No listening
// TCP port, private WeChat protocol, or access to the client's message database.
export async function desktopCommand(action: string, args: any = {}, config = loadDesktopConfig()) {
  const store = createDesktopStore(config);
  switch (action) {
    case 'status': return store.status();
    case 'observation': return { checkpoint: store.observation() ?? null };
    case 'observe': return store.observe(args);
    case 'pause': return { alert: store.pause(args.reason,args.screenshotPath,args.kind) };
    case 'resume': return { resumed: store.resume() };
    case 'hold-sending': return { hold: store.holdSending(args.reason,args.deliveryId,args.screenshotPath) };
    case 'pending-reconciliation': return { deliveries: store.pendingReconciliation() };
    case 'reconcile-receipt': return store.reconcileReceipt(args);
    case 'active-delivery': return { delivery: store.activeDelivery(args.leaseId) };
    case 'extend-delivery': return {delivery:store.extendDelivery(args.leaseId)};
    case 'incoming': return store.incoming(args);
    case 'incoming-batch': return {accepted:store.incomingBatch(args.messages)};
    case 'media-requests': return {sources:store.mediaRequests()};
    case 'media-request-finished': store.finishMediaRequest(args.source);return {finished:true};
    case 'sync-identities': return {people:syncDesktopIdentities(config).list().length};
    case 'receipt': return store.receipt(args);
    case 'ui-access': store.assertUiAccess(args.leaseId); return { allowed: true };
    case 'next-delivery': {
      let delivery = store.claimDelivery();
      if (!delivery) return { delivery: null };
      const deadline = Date.now() + 10_000;
      while (delivery.status === 'claimed' && Date.now() < deadline) {
        await pause(100); delivery = store.getDelivery(delivery.id);
      }
      if (delivery.status !== 'ready') {
        if (delivery.status === 'claimed') store.cancelUnsent(delivery.id, 'Sender did not authorize the GUI operation');
        return { delivery: null, reason: delivery.error || 'Delivery was not authorized' };
      }
      return { delivery, instruction: 'Use leaseId for the complete GUI operation. Verify the bound conversation, compose and send through visible controls, then report the actual outgoing bubble. Do not replay uncertain sends.' };
    }
    default: throw new Error('Unknown desktop bridge operation');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='serve') {
    for await(const line of createInterface({input:process.stdin})) {
      let id:unknown;
      try {const request=JSON.parse(line);id=request.id;
        const result=await desktopCommand(request.action,request.args);
        process.stdout.write(JSON.stringify({id,result})+'\n');
      }catch(error){process.stdout.write(JSON.stringify({id,error:error instanceof Error?error.message:String(error)})+'\n');}
    }
  } else {
  try {
    let body = ''; for await (const chunk of process.stdin) body += chunk;
    const result = await desktopCommand(process.argv[2], body.trim() ? JSON.parse(body) : {});
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1;
  }
  }
}
