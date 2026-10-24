// Shared by the Node worker and Ego runtime; no browser library dependency.
export function classifyShop(evidence, expectedShop) {
  const names=[...new Set(evidence.flatMap(e=>e.names))];
  const actualName=names.length===1?names[0]:null;
  return{status:names.length>1?'ambiguous':!actualName?'login-required':actualName===expectedShop?'verified':'mismatch',loggedIn:names.length>0,actualName,actualNames:names,evidence,checkedAt:new Date().toISOString()};
}
