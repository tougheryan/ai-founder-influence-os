#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
const gatewayUrl = (process.env.AIFIOS_GATEWAY_URL || '').replace(/\/$/, '');
const adminToken = process.env.GATEWAY_ADMIN_TOKEN || '';

if (!gatewayUrl || !adminToken) {
  console.error('Set AIFIOS_GATEWAY_URL and GATEWAY_ADMIN_TOKEN before using the admin CLI.');
  process.exit(1);
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function request(path, method = 'GET', body) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  return payload;
}

try {
  if (command === 'invite:create') {
    const result = await request('/admin/invites', 'POST', {
      label: option('--label'),
      quotaLimit: option('--quota'),
      expiresAt: option('--expires-at'),
    });
    console.log(`授权码: ${result.code}`);
    console.log(JSON.stringify(result.invite, null, 2));
  } else if (command === 'invite:list') {
    console.log(JSON.stringify(await request('/admin/invites'), null, 2));
  } else if (command === 'invite:revoke') {
    const id = args[0];
    if (!id) throw new Error('Usage: npm run invite -- invite:revoke <invite-id>');
    console.log(JSON.stringify(await request(`/admin/invites/${encodeURIComponent(id)}/revoke`, 'POST', {}), null, 2));
  } else if (command === 'invite:reissue') {
    const id = args[0];
    if (!id) throw new Error('Usage: npm run invite -- invite:reissue <invite-id>');
    const result = await request(`/admin/invites/${encodeURIComponent(id)}/reissue`, 'POST', {});
    console.log(`新授权码（只显示一次）: ${result.code}`);
    console.log(JSON.stringify(result.invite, null, 2));
  } else if (command === 'invite:quota') {
    const [id, quotaLimit] = args;
    if (!id || !quotaLimit) throw new Error('Usage: npm run invite -- invite:quota <invite-id> <count>');
    console.log(JSON.stringify(await request(`/admin/invites/${encodeURIComponent(id)}/quota`, 'POST', { quotaLimit }), null, 2));
  } else {
    console.error('Usage: invite:create [--label name] [--quota count] [--expires-at ISO] | invite:list | invite:revoke <id> | invite:reissue <id> | invite:quota <id> <count>');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
