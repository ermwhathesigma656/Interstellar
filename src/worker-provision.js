import { azureRequest } from "./worker-azure.js";

export const provisioningConfig = env => JSON.parse(env.PC_AZURE || "{}").provisioning;
const random = () => crypto.randomUUID().replaceAll("-", "");
export function newMachine(env, id) {
  const config = provisioningConfig(env);
  const hostname = `${id}-${config.resourceGroup.split("/")[2].slice(0,8)}.${config.location}.cloudapp.azure.com`;
  return { id, resourceId: `${config.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${id}`,
    url: `https://${hostname}`, location: config.location, key: random() + random(), password: `Pc!${random()}${random()}`, provisioning: true };
}

export function deploymentBody(env, machine) {
  const config = provisioningConfig(env), name = machine.id;
  // Existing PCs keep their region when the default for new PCs changes.
  const location = machine.location || new URL(machine.url).hostname.split(".")[1];
  const resource = (provider, type, suffix = "") => `${config.resourceGroup}/providers/${provider}/${type}/${name}${suffix}`;
  const pip = resource("Microsoft.Network", "publicIPAddresses", "-ip");
  const nsg = resource("Microsoft.Network", "networkSecurityGroups", "-nsg");
  const vnet = resource("Microsoft.Network", "virtualNetworks", "-vnet");
  const nic = resource("Microsoft.Network", "networkInterfaces", "-nic");
  const setup = Buffer.from(JSON.stringify({ hostname: new URL(machine.url).hostname, gatewayKey: machine.key, username: "pcadmin", password: machine.password })).toString("base64");
  const script = `$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force C:\\Interstellar | Out-Null; [IO.File]::WriteAllBytes('C:\\Interstellar\\setup.json',[Convert]::FromBase64String('${setup}')); Copy-Item -LiteralPath .\\pc-gateway.cjs -Destination C:\\Interstellar\\pc-gateway.cjs -Force; Copy-Item -LiteralPath .\\setup-pc.ps1 -Destination C:\\Interstellar\\setup.ps1 -Force; & C:\\Interstellar\\setup.ps1`;
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  return { properties: { mode: "Incremental", parameters: { password: { value: machine.password }, command: { value: command } }, template: {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#", contentVersion: "1.0.0.0",
    parameters: { password: { type: "secureString" }, command: { type: "secureString" } },
    resources: [
      { type: "Microsoft.Network/publicIPAddresses", apiVersion: "2024-05-01", name: `${name}-ip`, location, sku: { name: "Standard" },
        properties: { publicIPAllocationMethod: "Static", dnsSettings: { domainNameLabel: new URL(machine.url).hostname.split(".")[0] } } },
      { type: "Microsoft.Network/networkSecurityGroups", apiVersion: "2024-05-01", name: `${name}-nsg`, location, properties: { securityRules: [
        { name: "HTTPS", properties: { priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", sourceAddressPrefix: "Internet", sourcePortRange: "*", destinationAddressPrefix: "*", destinationPortRanges: ["80", "443"] } },
      ] } },
      { type: "Microsoft.Network/virtualNetworks", apiVersion: "2024-05-01", name: `${name}-vnet`, location,
        properties: { addressSpace: { addressPrefixes: ["10.0.0.0/24"] }, subnets: [{ name: "desktop", properties: { addressPrefix: "10.0.0.0/24" } }] } },
      { type: "Microsoft.Network/networkInterfaces", apiVersion: "2024-05-01", name: `${name}-nic`, location, dependsOn: [pip, nsg, vnet],
        properties: { networkSecurityGroup: { id: nsg }, ipConfigurations: [{ name: "primary", properties: { privateIPAllocationMethod: "Dynamic", publicIPAddress: { id: pip }, subnet: { id: `${vnet}/subnets/desktop` } } }] } },
      { type: "Microsoft.Compute/virtualMachines", apiVersion: "2024-07-01", name, location, dependsOn: [nic], tags: { project: "Interstellar" }, properties: {
        hardwareProfile: { vmSize: "Standard_B2as_v2" }, licenseType: "Windows_Client",
        osProfile: { computerName: "InterstellarPC", adminUsername: "pcadmin", adminPassword: "[parameters('password')]", windowsConfiguration: { provisionVMAgent: true, enableAutomaticUpdates: true } },
        storageProfile: { imageReference: { publisher: "MicrosoftWindowsDesktop", offer: "Windows-10", sku: "win10-22h2-pro-g2", version: "latest" },
          osDisk: { createOption: "FromImage", managedDisk: { storageAccountType: "StandardSSD_LRS" }, deleteOption: "Detach" } },
        networkProfile: { networkInterfaces: [{ id: nic }] }, securityProfile: { securityType: "TrustedLaunch", uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } },
      } },
      { type: "Microsoft.Compute/virtualMachines/extensions", apiVersion: "2024-07-01", name: `${name}/desktop`, location, dependsOn: [machine.resourceId], properties: {
        publisher: "Microsoft.Compute", type: "CustomScriptExtension", typeHandlerVersion: "1.10", autoUpgradeMinorVersion: true, forceUpdateTag: String(Date.now()),
        protectedSettings: { fileUris: [`${config.sourceRoot}/setup-pc.ps1`, `${config.sourceRoot}/pc-gateway.cjs`], commandToExecute: "[parameters('command')]" },
      } },
    ],
  } } };
}

export async function provision(env, machine, create = false) {
  const config = provisioningConfig(env);
  const response = await azureRequest(env, `${config.resourceGroup}/providers/Microsoft.Resources/deployments/${machine.id}?api-version=2022-09-01`,
    create ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(deploymentBody(env, machine)) } : {});
  const data = await response.json();
  if (response.status === 404 && !create) return "Missing";
  if (!response.ok) {
    console.warn("PC provisioning rejected", response.status, data.error?.code);
    throw new Error("Azure could not create this PC. Check the subscription's remaining credits and VM quota, then try again.");
  }
  return data.properties?.provisioningState || "Running";
}

// Save this inventory before deleting the VM: Azure otherwise loses its disk references.
export async function deletionResources(env, machine) {
  const group = provisioningConfig(env)?.resourceGroup;
  const name = machine.id;
  if (!group || !/^(pc-[a-f0-9]{12}|interstellar-pc-\d{2})$/.test(name)) throw new Error("Unknown PC resource layout");
  const resource = (type, suffix = "") => `${group}/providers/${type}/${name}${suffix}`;
  if (machine.resourceId.toLowerCase() !== resource("Microsoft.Compute/virtualMachines").toLowerCase()) throw new Error("PC is outside its configured resource group");
  const vm = await azureRequest(env, `${machine.resourceId}?api-version=2024-07-01`);
  if (!vm.ok && vm.status !== 404) throw new Error("Could not inspect the PC before deletion");
  const properties = vm.ok ? (await vm.json()).properties : {};
  const legacy = name.startsWith("interstellar-pc-");
  const nic = resource("Microsoft.Network/networkInterfaces", legacy ? "VMNic" : "-nic");
  if ((properties.networkProfile?.networkInterfaces || []).some(item => item.id.toLowerCase() !== nic.toLowerCase())) throw new Error("PC has an unexpected network interface");
  let disks = [properties.storageProfile?.osDisk, ...(properties.storageProfile?.dataDisks || [])].filter(Boolean).map(item => item.managedDisk?.id);
  const diskPrefix = `${group}/providers/Microsoft.Compute/disks/`.toLowerCase();
  const ownedDisk = id => typeof id === "string" && id.toLowerCase().startsWith(diskPrefix) &&
    new RegExp(`^${name}_OsDisk_[a-z0-9_]+$`, "i").test(id.slice(diskPrefix.length));
  if (disks.some(id => !ownedDisk(id))) throw new Error("PC has an unexpected disk; deletion needs owner review");
  if (vm.status === 404 || !disks.length) {
    // Also clean disks left by an interrupted initial deployment or an externally removed VM.
    const response = await azureRequest(env, `${group}/providers/Microsoft.Compute/disks?api-version=2024-03-02`);
    if (!response.ok) throw new Error("Could not inspect saved PC disks");
    const result = await response.json();
    if (result.nextLink) throw new Error("Disk inventory needs owner review");
    disks = result.value.filter(item => ownedDisk(item.id)).map(item => item.id);
  }
  return [
    `${machine.resourceId}?api-version=2024-07-01`,
    ...disks.map(id => `${id}?api-version=2024-03-02`),
    `${nic}?api-version=2024-05-01`,
    `${resource("Microsoft.Network/publicIPAddresses", legacy ? "PublicIP" : "-ip")}?api-version=2024-05-01`,
    `${resource("Microsoft.Network/networkSecurityGroups", legacy ? "NSG" : "-nsg")}?api-version=2024-05-01`,
    // The original PCs share a VNet. Only automatically created PCs have a dedicated one.
    ...(!legacy ? [`${resource("Microsoft.Network/virtualNetworks", "-vnet")}?api-version=2024-05-01`] : []),
  ];
}

export async function deleteResource(env, resource) {
  const response = await azureRequest(env, resource);
  if (response.status === 404) return true;
  if (!response.ok) throw new Error("Could not check PC deletion");
  const info = await response.json();
  if (info.properties?.provisioningState === "Deleting") return false;
  const removed = await azureRequest(env, resource, { method: "DELETE" });
  if (!removed.ok && removed.status !== 404 && removed.status !== 409) throw new Error("Could not finish deleting PC resources");
  // Accepted is not finished: retain ownership until a later GET confirms absence.
  return false;
}
