import {sfConn, apiVersion} from "./inspector.js";

// Resolve eligibility when the menu opens, even when IsActive was not exported.
export async function getRecordLoginLinks(sfHost, recordId, userInfoPromise) {
  if (typeof recordId !== "string" || !/^(005|003)[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(recordId)) {
    return [];
  }
  const isContact = recordId.startsWith("003");
  const query = "SELECT Id, IsActive FROM User WHERE IsActive = true AND "
    + (isContact ? "IsPortalEnabled = true AND ContactId" : "Id") + " = '" + recordId + "' LIMIT 1";
  const result = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(query));
  const user = result.records[0];
  if (!user || !user.IsActive) {
    return [];
  }
  const userInfo = await userInfoPromise;
  if (!userInfo?.organizationId || user.Id.substring(0, 15) === userInfo.userId?.substring(0, 15)) {
    return [];
  }
  const url = new URL("https://" + sfHost + "/servlet/servlet.su");
  url.searchParams.set("oid", userInfo.organizationId);
  url.searchParams.set("retURL", "/" + recordId);
  if (!isContact) {
    url.searchParams.set("suorgadminid", user.Id);
    url.searchParams.set("targetURL", "/");
    return [{label: "Login As", href: url.href}];
  }
  const networks = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(
    "SELECT NetworkId, Network.Name FROM NetworkMember WHERE MemberId = '" + user.Id + "' ORDER BY Network.Name"
  ));
  return networks.records.filter(member => member.NetworkId).map(member => {
    const networkUrl = new URL(url);
    networkUrl.searchParams.set("sunetworkid", member.NetworkId);
    networkUrl.searchParams.set("sunetworkuserid", user.Id);
    return {
      label: "Log in to Experience as User" + (networks.records.length > 1 ? " (" + (member.Network?.Name || member.NetworkId) + ")" : ""),
      href: networkUrl.href
    };
  });
}
