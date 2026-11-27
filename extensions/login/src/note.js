// Customer note (Shopify customer "note" field), shared by the Login tile and modal, read through the Hera_POS_aid backend.
// Do not change SERVER_URL: Apple Wallet cards also point to this address.
export const SERVER_URL = "https://search-0wf4.onrender.com";

export async function fetchNote(customerId) {
  let token = null;
  try { token = await shopify.session.getSessionToken(); } catch { /* none */ }
  const resp = await fetch(`${SERVER_URL}/api/customer-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ customerId: String(customerId) }),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* not JSON */ }
  if (!resp.ok) throw new Error(data?.error || `Error ${resp.status}`);
  return data; // { hasNote, note, name }
}

export function cartCustomerId() {
  try { return shopify.cart.current.value?.customer?.id ?? null; } catch { return null; }
}
