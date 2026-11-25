// Setup runs before the window has a bound project backend. Only request fixed
// project endpoints from the signed-in server, including the protected logo.
export const LOGO_LIMIT = 512 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function requestOptions(token) {
  return { headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    cache: 'no-store', signal: AbortSignal.timeout(15000) };
}

export async function readProjectLogo(baseUrl, token, projectId, identity) {
  if (!identity?.logo_url) return null;
  const res = await fetch(`${baseUrl}/api/projects/${Number(projectId)}/logo`, requestOptions(token));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type')?.split(';')[0];
  if (!LOGO_TYPES.includes(type) || Number(res.headers.get('content-length')) > LOGO_LIMIT) throw new Error('invalid_project_logo');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > LOGO_LIMIT) throw new Error('invalid_project_logo');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}

export async function readSetupProfile(baseUrl, token, projectId) {
  const path = projectId == null ? 'company-policy' : `${Number(projectId)}/settings`;
  const res = await fetch(`${baseUrl}/api/projects/${path}`, requestOptions(token));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (projectId == null) {
    if (!data.rules) throw new Error('Invalid company policy response');
    const rules = Object.fromEntries(Object.entries(data.rules).map(([field, value]) => [field, { value, source: 'company' }]));
    return { policy: { company: data.company, rules } };
  }
  if (!data.settings) throw new Error('Invalid project settings response');
  return { policy: data.policy, identity: data.identity, logo: await readProjectLogo(baseUrl, token, projectId, data.identity) };
}
