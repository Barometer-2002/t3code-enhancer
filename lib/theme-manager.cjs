"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ENHANCER_VERSION } = require("./version.cjs");

const THEME_ID = "chatgpt-app";
const SOURCE_THEME_PATH = path.resolve(__dirname, "..", "themes", `${THEME_ID}.json`);
const LAYER_1_MARKER = "/* === LAYER 1:";
const LAYER_2_MARKER = "/* === LAYER 2:";

// Cryptographic SHA-256 digests of every unmodified historical release/commit of themes/chatgpt-app.json
// (raw bytes, LF-normalized text, JSON.stringify canonical form, and Layer-1 extracted forms).
const KNOWN_HISTORICAL_THEME_HASHES = new Set([
  "a81d18a86fe63424ce2a3c3240bc6ef9839d3bba538cedbe48c69cede5d396cf",
  "51546988c63cb320d0cee4a584096658169c08b7969babbe263e2a5712da3109",
  "23997a595e1e5df6fdeef9b6ec1f98be6fa263f11da978b5db6619286140a97b",
  "56c687c0839fa4d1f30c5919cb8662fc1f5f453ba24bc090351899ab4315caa0",
  "3708043ed9bd87a146417bce6516718bac8683cce3ad3b425b95b40115cbff62",
  "190172b0115feb9276cbafe4759cb31dede8646b2d9ce2bb4138c872946e4929",
  "b5b5d8201e2b9bcbd5c90eb0d87eeee94f7f2c9ef87487edf4c1638511bd0d03",
  "bc2efa45b5d0d778955b220b3cc7c526354d4e121729716024cc0ba88e0a146c",
  "d538623039f4ec976bff046e1ffb692e8e3727d7db1b62a4e2ef23b40f9b51cf",
  "796787a8746bc008142936340cb3ebd4c27e8f73ee9bb9fb0732685ac4a611cd",
  "a8a51b57cd21490bb8a07e204186c9e8e6849c75fb6bafa4e377792eb94d07da",
  "1b2fe35757c6f68713f584fadeb7e704efb6f5f9c806cbe6a38946d1dca8614a",
  "74d96ed87676247798df2c351da9ddb47bfb90c17072c5ef70844c8c3bbe7308",
  "5a4de0638ba3ba8c00d7a6b36702c7a77ac553ef5829aab802c713f37cf47550",
  "f84ee9ba8f45afdaf63d315b63fdbb1e137a3cb6676e5d7e275f9189402a2cf1",
  "e1e8a49640bb1f3077f3cfc1f6d6e1bc74a87dccd2946d2d255ba339cb8765eb",
  "05eb19a732c5d327649f8628987ee6f0cf8cb84d1a4baa921ba0018d3221a28d",
  "bcfd603c22091cb2b53a0479763257d87b2981ce709890868aef6a3e83128f4e",
  "ab413b9d5cfb57e85d76605a1cc16657804576ff1c10143a91dcca35ee15650e",
  "94c465eaa01c5f02d5308f8d18baa4b7595ea442f694456db1f82c73196ddb92",
  "e1b3b8e49e97777ee97302088512ccd8a4c4d06a968b083dd333172c696fa00e",
  "8861043a6b20ff405e7c275ca906614c0756b72cafbf68d359982dca5075dea9",
  "4289428763d860740b3b2749d6050f19ef5604c1ef8e6a13b39224cacb093c18",
  "ced06ad1b7d4d28e5a5cc16a24635fdf4a31a4ac2bd000f6d0a9bd1b069a3024",
  "a5fd1bbc86bf80b6855f030a46c8044de9f2c9e4401218d34a481ffc6a19f273",
  "44ac98d039415a735a9ce05f9bc0c38aefd543b55bda5c2de08745f748b3c6fe",
  "751acca57cfeecc6a324b2e66d0a776cd5bc9fc962c03e3a7770197f66a2f1cb",
  "1d04ce455bcd208bd99796db6a07b85df79edbedf6be166582364367de0145e7",
  "ad5d796d5449b612e145a3d957cc86727b7093e35f929cc8c0edafb5590a5a54",
  "cf37c5502ac1a335308904ab4df40e08519222661bceeb061e7ed4c5f13a04af",
  "dc2014a4f9356e97a96839ec877c8bf0ff93be8c7f01414f567daf0ece31a2fa",
  "57ac159c5046bbdb0635795be044f0a74c58b6361540c11f5be0d094223c2979",
  "fed2cbc77d4659d05bc37045967ade6ae5a0478a666d5bc95c740359839bad44",
  "b32c10304a04167caa8ca55c1ce93e3b4e0b03520c715a40e5945241dad6b352",
  "0f0e2db74fa5dcdf514bd000074a05aafcbc0a0afc2a41f08b8760d3b804e95c",
  "89ea32cf00d29880932f1ca2746916f53d3fbf55821000c30696e5cacea7d635",
  "1081ccadf21b70be2e1f95572633a68c3fcb90d9624e367a0a314d6b704529cf",
  "263f39d4245610b8a1b112bc3790d853faa22ad5b00a6d8a1114ad53c279ce60",
  "de987e5cf1d7700980a5c348d82e39f4e535a46e62ab078f0d6eba32ab87ad89",
  "e9a8f81869921da4f6532957c848c1a38d50ae394245c0b19df0df639006d613",
  "cec4ba92b13f0c92287312e1b622f5dd5980bbfbfeea90462f954e6840192916",
  "1d4bd86ac56e45d5c500cf0e6d36106337c4a293d8664d44cf72ad4bf835c5b0",
  "5f287afa6823e7c4a3cc9d3a1b956339e40c9d61a8004d3acab8940ce7dfa196",
  "36b45ab7b457566a5a2c6da9bb8ee508d40d223da3677706072bb54ebc9c2ff5",
  "44f9391fbff08650b63ab02306a2eee7d6103cfcfbf6d5f5413a1ade74c998be",
  "3a82ff8a52fd7d884f0d31ba73ec64526df444909114d5cdd960e6f33d3169d",
  "504a2601cfaf67e4b677eddfcdf3f7d85e7a32e7c5c8c2c7d82e75fb4c8a2ded",
  "5cc6877c99e5f5fb3e84a4f0b066b07095585b5f38742876681fb1c44da86a9e",
  "2e8acb9c38382fd00bd713129d91054c1b5c6d1ca3b23f767bdd5686d1609bcd",
  "9ae0e6a0f79c400fb115cda2ca19ecda753405035cd7e6b3c8f789043a423ab4",
  "8103ed82ee16a5a0d82b591ef3c63013a3511177f41b4168835509b2cd2b55ac",
  "675b456f7e9bb04ccd5410a76fb0ee2c3c275b2d0b17f77d769ca8d790bf1d50",
  "e09a66d126718e4cf0b1a0e8167f4e4d2fb93ac02b0094ec6ce8782846b84af9",
  "729ff7659c525cf8862db0b9256f6f95a92e840340c54d49163ce6484ce26697",
  "13b34ee177ad3607d928160c81d3853dcd36783ba14abe0c5cce4fa2715b9a48",
  "f80a77511515758cf4049c039b09ae8ffd3f2d9a8183ea0f0c575953fab4caec",
  "8301e42d43fb79166e38a42bddcfce2ffd6fe8f4866b9128079d2faf9fd78fef",
  "3b107c8a926f4957e23cdadd0eee3911dea5b411ea82ff4f8bb1c90f65ff9c37",
  "c0d955946580ef411d7e05b7ac2f91765a885d918f893795337c7379df14d789",
  "66aa12a12e573873d441b4bd812eb3be1a4cae1f587265d6f0fa9c4e18d5ceb6",
  "9af036d906c60dfea1d3ce4293eec3e74e77cdd8175ce689647083d50be083ec",
  "9f220a468a63ab9ee5cc488e258137c7bdce77d82243b661d43fcf932ee99a75",
  "e253b89624c024d404e326871b84d2a33ccdee2b7443aa4eab32c322e69f6900",
  "2202c5833d20ebd3a698a6dcced2cedb27ebfe1efd7a954cc8beb83068f0a778",
  "8ba2d4032425f7110e27f226bc73c0f99b5a8b722a5c09c9536109fec8b786be",
  "5452cc59800662a332e65cee54b5553054c8d3bd6be4307937bc6f8a892b48c1",
  "0906585826fc5e0b84813d17303027732703e11637742e02232874464f5ae606",
  "dcb44e70a2067bab6499715568f8d35c52a29cbb8e82a7676d99552e608d78c0",
  "f62cb93c045eb532fe12c834b97dc85364a4b5369c3e75410058922a373ad329",
  "2333e0776ec948cc053cb85b8e281252fe675a7bf8bb3f5026e779fbc3df7fbb",
  "da2b4e6406359968f7458d6487f84918675dd4ee8843907fca6d2a745f8a956a",
  "26ca6d4f366f50c8bb93e78e36215fd0560ab9af716cbdbabad8d625e22994e7",
  "0087ba7f3bf94fd63a9b5bdb1dafb90658918a1ce29af383421d046df44a1287",
  "7c816ec0f236ac03088fb64cd1b9f9d9b6a5769e21aade976af455b44eac5ce0",
  "afdf8746ee9f5855dc1dece0d2d4cef69b55d21c91fecc088f104ced7be7fc7c",
  "334b4a60da56a77d1b99e6a11be487bc56dbb9f6195fb0c58ed45e0b0458d588",
  "d0732fbeb5f9b4306cdeaab7fef106eeeb0ecbdd11308d1436760fe748b07756",
  "d62bd1cf0eb0a00bd8f9f94686064ea99cb20a8bbb9b79ef116fb79b5b193ec9",
  "32050a338856e938d68c1f560cbafcad7b3db31fac3e1e4839faaa3427c11843",
  "b48aca7dfe788013eefc6767253cf45a636bd5918afa97e86b6a2b1329d496c6",
  "b5dafa0aae49cf90eb9c42e3cb08b1d5d6f837e14fc602b50cce4302179da7e8",
  "995751a42f218e25c0ea921aef5946f6807309579720fef3d68ef0c79238196b",
  "a7327db4f7a5a25832616c2810367f18472b7a1c9d0cb1b4bffd8b260f7be9c1",
  "0730781e531f185da9fe45df407e6b1894d5c50c502c4a5f052e72bf3c8c7d11",
  "29b060ca74e6ebf4b76b01b980196ff4a1ea577a8746912e73141f27f881a1aa",
  "0743c5515b083de551f809d16d00ad29eeba6f2227cd889959062ef453142f87",
  "725a3fe5a5d0445180183f0e675e60c28807a57649def2023dbe67366913de12",
  "8139b85c4ad167d4ae4680f08b3d2856f69f170cdd94fd8745565d870fecdcd3",
  "8c1470d59a6ffcb7ff7d029e7d7374d5156644f969a6c43fbc5325e11b311051",
  "4b31df3d1f47d52305a8fb7194d11d07bfc12c12f140d1e1636846547dd597af",
  "5fdf3a8d47e0807d06d948e2f6117dcceec5421323dd96f610b8a97b63af7188",
  "c2e4a4213be7d83d27b7ce6593b264476f5702b78bea49cba61a6a12076c8ed2",
  "f181498fc9ab7a84896a060d2f7fd4be6be4d82c55bacbcea798214aed44f54e",
  "f52ce300013262e8b7b42e367dddd7fc4de0e3ed51bb287893b113440959cfde",
  "73d09d364137b9b25759c30ab36c52d543eabc1647ce80d3a1932ab581251be5",
  "c23d6afed2b9879feb983c3aece5e70f2f9dcf817eacc290a526f4f5af18b158",
  "41aa3ff2adc7996c65a95164440ee4b20fba0bd5f0c4a5bf266856d6936e8dcb",
  "386aba4b694f1f396d3579f85dcf5504bf40620e1b4fcb62238113db9f8ab56a",
  "c84823b285639e2bb20c3cc8f41f954d6984c121c94ad8b73a767280d5d21f26",
  "cbd8a4a62af01dcd8dc96561ffdb2a11bb06013a8d741d7dc1cd4c7e1bb60244",
  "f3e3ee1a0a25fe6be5b36a70a2d37e96b5b3b4c249a7a275030718b7ca27d191",
  "5f07625c97079af4f6a159c4bcf0930a2d9b85edb2669346d40a8c8826439660",
  "ef3f9dfd92abef9360a02dbde3584cb10c9aaad6bd515463dbdee8b9263b9f74",
  "f37de5f58d382b93d938d854aacf32132a4b7b332d6aa345288a2bd5fd35789c",
  "e1e366ebf42bc5807129cb17d2d55caa2fc70d4b5341e18f2bde5d742ec592b0",
  "d9bdee161de938dfe09b4b219e30e9390a0bbd0b0c338cb1cf08d3ad97a148c0",
  "8429218c36cecff8dda7b325fab1b7c9b365b8ec116e8668873828e3c353989f",
  "c5e2906d20b32a74bd4b33010dd8e3c27771d6c65af11cc6717368fed8a31635",
  "78f633c4a3470ed68af6172591407eb13c5fde2aa49566a56f2ce0a39980f28e",
  "8e3b065eeafccf134fb91aaf54bc5d784122f8b2dd7be85d4317984390da02bc",
  "9f5a49bfe0747928593c13e2632286f912b23f2b710264d19b78e7449b833dec",
  "0259221b872aa0e81b0cedc0db514ec80d1c076936032a91fda465db4208daf0",
  "bdfb93bf99b3d254a7f731a1b6c3e62c681acc7f746cce55656f5327f8fa4962",
  "8dbaa1e14c17db1d00a0a3e6b18301c62e8d296d928cff9551f55f4115f9e4a6",
  "a63a4861b4e63286bdf06a0b16c0e9b476071d54a93aacedbae55191e73cdc43",
  "59415d04b124f1dacf82a9f36d23e116319dba339e6ab0e82c1f6bd853090350",
  "1c0f5765d8f0ade2be0d811617b70f69e45433191fa6d15c2e06f06b0f9d1d8b",
  "da1a12cc4c1aead8ebcf29fa352b46b38a3e7afdb7d1245a195fe6c33c0f8ecd",
  "419afc42eb1df049828365a03eba7972d7802648cc0673900fafd0706a5fc7d3",
  "b9a5c8ca467419842dd809a4eedb11fba415f6be233ddb7f030d00af0d1fea13",
  "2cfbe1f7b6ca6ee7fc748ce734ba1cc2a3dd479b1afe7250590b766cd8a2719b",
  "db8db9e0a70b3fc67a5026a30e6d688b1f7989fb1e4f877e9b025b1617513a14",
  "ab1ce792fb417f96077b00018331f7f2f26cd993321b552d5456a9ac81bdf919",
  "6b120963878ef8c262fa3cb823f02fe9809f787ee38677573b25f33f0865fcb2",
  "3cd5d3aa6f8a2cd596210236b74b283e6315248ae9edc53473e6f3d6576fbb1e",
  "d48266af6009390f52aeb4906fd1628a5383923fa2e6161b3c468e08ab60efa7",
  "88ec0f5bf69776a23926ae1ffe594052609abce57f965b3943c7a2b619b5df35",
  "68bbe0c422fb5ad023334aeed4e2f34a5796d4c9bbf1026e9486347f82c46ea0",
  "25edecd8fe78ca2df7a6404ce94dafffcc4ebc701e453b9bf9a602a6e1868677",
  "11a27212436e52e99d4406eb3a7eb5a4c0df235052477b4b1b057ef6e586db28",
  "69d47335520bb0ac313b84a573272f07d6acc2c006b0e599443de1d957706b17",
  "d9e0ec012f366c7e9f922b192a7fcb0b7d8d1e0230403bcc189ef11211d07c0b",
  "6471dc6c0daf77035f60ae59ea821d9c759b99c26e20ac21668318dd4873d195",
  "61c1f76f9fe7def52dc52a60a661e411000a0696fc2c4101c3f09b31c6314326",
  "9af4e7b1a50dd4ce4dbd2049c00157551e9da89e85f7ea2f87e414e5d7e77ca4",
  "0668f025287705b8ba92b0082203249ede692cb4db95700ad8aec82e6fcc8cd2",
  "1e95024bbc6a9bfd2a4dd6ece06669fd0f8dada5b02c9050199a7018d9524117",
  "a6bd233b03a770891b4a7e14d1883c4eee8ac5040b700845a682363118c63861",
  "f5ce62724a87ce04a7ecede7c56a5e31ef854d2ef3dd425edb5abae8db9711c3",
  "7e3c2ba66001b8d6763e01fd53375940bfbf458496ca9463611bc4969a4b4fd1",
  "8992c397b9af3a105ed4fc9f3b27e4b5ce07576fe82a738a4b9e5c653544d6dc",
  "5a05948e49ec66e6bfc099943eb204665178dc4c6a398e9eda699dbae5f629b5",
  "44b021127a0a2e4a71b561338f31750eceadc93cfb598e027244345c87278749",
  "cc077a508a85f492f88ebd28c650d9b2af1606223ad235c5662ec667c14817ee",
  "323e16c2488f3fc62cda2468a0e73855e5e5397c6efcb34e22d7456de354e0c3",
  "0faa7cb468e7ec1ae8a4bf8537a8ae184cea2a94199f556769caf22745f9e04b",
  "5edf380f4abcb17e9a02fdda3504003a7c0b958b404c7ab3a9f05ee5ccc3dabb",
  "1e77de39a671da22a498388c2ee74cdbd451c4eefddc92ed73ba56b8c1e0279b",
]);

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(String(text), "utf8")).digest("hex");
}

function getDefaultUserdataDir() {
  return process.env.T3CODE_HOME
    ? path.join(path.resolve(process.env.T3CODE_HOME), "userdata")
    : path.join(os.homedir(), ".t3", "userdata");
}

function writeFileAtomic(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: options.mode });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function writeBinaryAtomic(filePath, buffer, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, buffer, { mode: options.mode });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function getUserdataDir(sharedData, profileDirectory, sharedUserdata = path.join(os.homedir(), ".t3", "userdata")) {
  return sharedData ? sharedUserdata : path.join(profileDirectory, "t3-home", "userdata");
}

function getThemePaths(userdataDir = getDefaultUserdataDir()) {
  const themesDir = path.join(userdataDir, "themes");
  return {
    userdataDir,
    themesDir,
    settingsPath: path.join(userdataDir, "settings.json"),
    metaPath: path.join(userdataDir, ".t3code-enhancer-theme-state"),
    targetThemePath: path.join(themesDir, `${THEME_ID}.json`),
    backupThemePath: path.join(themesDir, `${THEME_ID}.json.before-enhancer`),
  };
}

function readThemeMeta(userdataDir = getDefaultUserdataDir()) {
  const { metaPath } = getThemePaths(userdataDir);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeThemeMeta(userdataDir, meta) {
  const { metaPath } = getThemePaths(userdataDir);
  writeFileAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
}

function readSettings(userdataDir = getDefaultUserdataDir()) {
  const { settingsPath } = getThemePaths(userdataDir);
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

function setActiveThemeInSettings(themeId, userdataDir = getDefaultUserdataDir(), setAtOverride = undefined) {
  const { settingsPath } = getThemePaths(userdataDir);
  const settings = readSettings(userdataDir);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  if (themeId) {
    settings.defaultTheme = themeId;
  } else {
    delete settings.defaultTheme;
  }
  if (setAtOverride === null) {
    delete settings.defaultThemeSetAt;
  } else if (typeof setAtOverride === "string") {
    settings.defaultThemeSetAt = setAtOverride;
  } else {
    settings.defaultThemeSetAt = new Date().toISOString();
  }
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return true;
}

function extractOfficialTheme(themeObj) {
  const css = typeof themeObj.css === "string" ? themeObj.css : "";
  const idx = css.indexOf(LAYER_2_MARKER);
  const officialCss = idx >= 0 ? css.slice(0, idx).trimEnd() + "\n" : css;
  return { ...themeObj, css: officialCss };
}

function parseTheme(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function getBundledThemeTexts() {
  if (!fs.existsSync(SOURCE_THEME_PATH)) return null;
  const fullText = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
  const parsed = JSON.parse(fullText);
  const officialObj = extractOfficialTheme(parsed);
  const officialText = JSON.stringify(officialObj, null, 2) + "\n";
  return {
    fullText,
    officialText,
    serializedFull: JSON.stringify(parsed),
    serializedOfficial: JSON.stringify(officialObj),
  };
}

function isKnownUnmodifiedEnhancerTheme(rawText, parsed, meta, bundled) {
  if (!parsed || parsed?.name !== "ChatGPT App") return false;
  const rawHash = sha256Text(rawText);
  const lfHash = sha256Text(rawText.replace(/\r\n/g, "\n"));
  const canonicalHash = sha256Text(JSON.stringify(parsed));
  if (Array.isArray(meta?.installedHashes) && (
    meta.installedHashes.includes(rawHash) ||
    meta.installedHashes.includes(lfHash) ||
    meta.installedHashes.includes(canonicalHash)
  )) {
    return true;
  }
  if (bundled) {
    if (rawText === bundled.fullText || rawText === bundled.officialText) return true;
    const serialized = JSON.stringify(parsed);
    if (serialized === bundled.serializedFull || serialized === bundled.serializedOfficial) return true;
  }
  if (
    KNOWN_HISTORICAL_THEME_HASHES.has(rawHash) ||
    KNOWN_HISTORICAL_THEME_HASHES.has(lfHash) ||
    KNOWN_HISTORICAL_THEME_HASHES.has(canonicalHash)
  ) {
    return true;
  }
  return false;
}

function isEnhancerOwnedTheme(theme) {
  const css = typeof theme?.css === "string" ? theme.css : "";
  return theme?.name === "ChatGPT App" && (
    css.includes(LAYER_1_MARKER) ||
    css.includes(LAYER_2_MARKER)
  );
}

/**
 * Reconstruct ordered backup stack [oldest ... newest] inside themesDir from persisted metadata + disk scan.
 */
function resolveBackupStack(userdataDir, meta) {
  const { themesDir, backupThemePath } = getThemePaths(userdataDir);
  if (!fs.existsSync(themesDir)) return [];
  const entries = [];
  const seen = new Set();
  const addEntry = (fileName, kind = "user-edit", createdAt = null) => {
    if (!fileName || typeof fileName !== "string") return;
    const base = path.basename(fileName);
    const absPath = path.join(themesDir, base);
    if (seen.has(absPath)) return;
    const st = fs.lstatSync(absPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return;
    seen.add(absPath);
    entries.push({ file: base, absPath, kind, createdAt });
  };

  if (Array.isArray(meta?.backups)) {
    for (const item of meta.backups) {
      if (item && typeof item.file === "string") addEntry(item.file, item.kind || "user-edit", item.createdAt || null);
    }
  }
  // Legacy / unindexed primary backup goes before newer timestamped user backups when missing from meta.backups
  if (fs.existsSync(backupThemePath) && !seen.has(backupThemePath)) {
    const st = fs.lstatSync(backupThemePath, { throwIfNoEntry: false });
    if (st && st.isFile()) {
      entries.unshift({
        file: path.basename(backupThemePath),
        absPath: backupThemePath,
        kind: "third-party",
        createdAt: null,
      });
      seen.add(backupThemePath);
    }
  }
  const diskUserBackups = fs.readdirSync(themesDir)
    .filter((name) => name.startsWith(`${THEME_ID}.json.user-`) && name.endsWith(".before-enhancer"))
    .sort();
  for (const name of diskUserBackups) {
    addEntry(name, "user-edit", null);
  }
  return entries;
}

function getThemeStatus(userdataDir = getDefaultUserdataDir()) {
  const { targetThemePath } = getThemePaths(userdataDir);
  const meta = readThemeMeta(userdataDir);
  const installed = fs.existsSync(targetThemePath);
  const hasBackup = resolveBackupStack(userdataDir, meta).length > 0;
  const settings = readSettings(userdataDir);
  const active = settings?.defaultTheme === THEME_ID;
  let matchesBundled = false;
  let officialOnly = false;
  let managed = false;
  if (installed && fs.existsSync(SOURCE_THEME_PATH)) {
    try {
      const targetRaw = fs.readFileSync(targetThemePath, "utf8");
      const targetParsed = JSON.parse(targetRaw);
      const bundledParsed = JSON.parse(fs.readFileSync(SOURCE_THEME_PATH, "utf8"));
      managed = isKnownUnmodifiedEnhancerTheme(targetRaw, targetParsed, meta, {
        fullText: fs.readFileSync(SOURCE_THEME_PATH, "utf8"),
        officialText: JSON.stringify(extractOfficialTheme(bundledParsed), null, 2) + "\n",
        serializedFull: JSON.stringify(bundledParsed),
        serializedOfficial: JSON.stringify(extractOfficialTheme(bundledParsed)),
      }) || isEnhancerOwnedTheme(targetParsed);
      const serializedTarget = JSON.stringify(targetParsed);
      const serializedFull = JSON.stringify(bundledParsed);
      const serializedOfficial = JSON.stringify(extractOfficialTheme(bundledParsed));
      const css = typeof targetParsed?.css === "string" ? targetParsed.css : "";
      officialOnly = css.includes(LAYER_1_MARKER) && !css.includes(LAYER_2_MARKER);
      matchesBundled = serializedTarget === serializedFull || serializedTarget === serializedOfficial;
    } catch {
      matchesBundled = false;
    }
  }
  return { themeId: THEME_ID, targetPath: targetThemePath, installed, active, hasBackup, matchesBundled, officialOnly, managed };
}

function formatThemeStatusText(themeStatus) {
  if (!themeStatus?.installed) return "未安装";
  const layerHint = themeStatus.officialOnly ? " · Layer 1 官方层" : "";
  const versionState = themeStatus.matchesBundled ? "已安装（最新" : "已安装（与项目内版本有差异";
  const activeState = themeStatus.active ? "已激活" : "未激活";
  return `${versionState}${layerHint} · ${activeState}）`;
}

function assertWritableDirOrMissing(dirPath) {
  const st = fs.lstatSync(dirPath, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) {
    const err = new Error(`ENOTDIR: not a directory, mkdir '${dirPath}'`);
    err.code = "ENOTDIR";
    throw err;
  }
}

function assertWritableFileOrMissing(filePath) {
  const st = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (st && st.isDirectory()) {
    const err = new Error(`EISDIR: illegal operation on a directory, open '${filePath}'`);
    err.code = "EISDIR";
    throw err;
  }
}

/**
 * Validate theme prerequisites and snapshot current files before committing ASAR changes,
 * supporting rollback if any theme write fails mid-transaction.
 */
function prepareThemeTransaction(userdataDir = getDefaultUserdataDir(), options = {}) {
  const targetUserdata = userdataDir || getDefaultUserdataDir();
  const officialOnly = options.officialOnly === true;
  const activate = options.activate !== false;
  const { themesDir, settingsPath, metaPath, targetThemePath, backupThemePath } = getThemePaths(targetUserdata);

  assertWritableDirOrMissing(userdataDir);
  assertWritableDirOrMissing(themesDir);
  assertWritableFileOrMissing(targetThemePath);
  assertWritableFileOrMissing(settingsPath);
  assertWritableFileOrMissing(metaPath);

  const bundled = getBundledThemeTexts();
  assert(bundled, `Bundled theme missing: ${SOURCE_THEME_PATH}`);
  const content = officialOnly ? bundled.officialText : bundled.fullText;

  const snap = {
    targetUserdata,
    userdataExisted: fs.existsSync(targetUserdata),
    themesExisted: fs.existsSync(themesDir),
    targetExisted: fs.existsSync(targetThemePath),
    targetBytes: fs.existsSync(targetThemePath) ? fs.readFileSync(targetThemePath) : null,
    settingsExisted: fs.existsSync(settingsPath),
    settingsBytes: fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null,
    metaExisted: fs.existsSync(metaPath),
    metaBytes: fs.existsSync(metaPath) ? fs.readFileSync(metaPath) : null,
    createdBackups: [],
  };

  let committed = false;
  const commit = () => {
    fs.mkdirSync(targetUserdata, { recursive: true, mode: 0o700 });
    fs.mkdirSync(themesDir, { recursive: true, mode: 0o700 });
    const prevMeta = readThemeMeta(targetUserdata);
    const currentSettings = readSettings(targetUserdata);
    const backups = resolveBackupStack(targetUserdata, prevMeta).map(({ file, kind, createdAt }) => ({ file, kind, createdAt }));

    let savedBackupPath = backups.length ? path.join(themesDir, backups[backups.length - 1].file) : null;
    if (fs.existsSync(targetThemePath)) {
      const current = fs.readFileSync(targetThemePath);
      const currentText = current.toString("utf8");
      const currentParsed = parseTheme(currentText);
      const unmodifiedEnhancer = isKnownUnmodifiedEnhancerTheme(currentText, currentParsed, prevMeta, bundled);
      if (currentText !== content && !unmodifiedEnhancer) {
        if (!fs.existsSync(backupThemePath) && backups.length === 0) {
          writeBinaryAtomic(backupThemePath, current);
          snap.createdBackups.push(backupThemePath);
          backups.push({
            file: path.basename(backupThemePath),
            kind: isEnhancerOwnedTheme(currentParsed) ? "user-edit" : "third-party",
            createdAt: new Date().toISOString(),
          });
          savedBackupPath = backupThemePath;
        } else {
          const customBackupName = `${THEME_ID}.json.user-${Date.now()}-${randomUUID().slice(0, 6)}.before-enhancer`;
          const customBackupPath = path.join(themesDir, customBackupName);
          writeBinaryAtomic(customBackupPath, current);
          snap.createdBackups.push(customBackupPath);
          backups.push({
            file: customBackupName,
            kind: "user-edit",
            createdAt: new Date().toISOString(),
          });
          savedBackupPath = customBackupPath;
        }
      }
    }

    writeFileAtomic(targetThemePath, content);

    const installedHashes = Array.from(new Set([
      ...(prevMeta?.installedHashes || []),
      sha256Text(content),
      sha256Text(JSON.stringify(JSON.parse(content))),
    ])).slice(-16);

    const nextMeta = {
      enhancerVersion: ENHANCER_VERSION,
      installedHashes,
      backups,
      changedDefaultTheme: prevMeta?.changedDefaultTheme ?? false,
      hadPreviousDefaultTheme: prevMeta?.hadPreviousDefaultTheme ?? false,
      previousDefaultTheme: prevMeta?.previousDefaultTheme ?? null,
      previousDefaultThemeSetAt: prevMeta?.previousDefaultThemeSetAt ?? null,
    };

    if (activate) {
      if (currentSettings && typeof currentSettings === "object" && !Array.isArray(currentSettings)) {
        if (currentSettings.defaultTheme !== THEME_ID) {
          nextMeta.changedDefaultTheme = true;
          nextMeta.hadPreviousDefaultTheme = Boolean(
            Object.prototype.hasOwnProperty.call(currentSettings, "defaultTheme") && currentSettings.defaultTheme
          );
          nextMeta.previousDefaultTheme = currentSettings.defaultTheme ?? null;
          nextMeta.previousDefaultThemeSetAt = currentSettings.defaultThemeSetAt ?? null;
        }
      } else if (!fs.existsSync(settingsPath) && options.createSettingsIfMissing) {
        nextMeta.changedDefaultTheme = true;
        nextMeta.hadPreviousDefaultTheme = false;
        nextMeta.previousDefaultTheme = null;
        nextMeta.previousDefaultThemeSetAt = null;
      }
    }

    let activated = false;
    if (activate) {
      activated = setActiveThemeInSettings(THEME_ID, targetUserdata);
      if (!activated && !fs.existsSync(settingsPath) && options.createSettingsIfMissing) {
        writeFileAtomic(settingsPath, JSON.stringify({
          defaultTheme: THEME_ID,
          defaultThemeSetAt: new Date().toISOString(),
        }, null, 2) + "\n", { mode: 0o600 });
        activated = true;
      }
    }
    writeThemeMeta(targetUserdata, nextMeta);
    committed = true;

    return {
      installed: true,
      officialOnly,
      activated,
      targetPath: targetThemePath,
      backupPath: savedBackupPath,
    };
  };

  const rollback = () => {
    for (const bp of snap.createdBackups) {
      fs.rmSync(bp, { force: true });
    }
    if (snap.targetExisted && snap.targetBytes !== null) writeBinaryAtomic(targetThemePath, snap.targetBytes);
    else if (!snap.targetExisted) fs.rmSync(targetThemePath, { force: true });

    if (snap.settingsExisted && snap.settingsBytes !== null) writeBinaryAtomic(settingsPath, snap.settingsBytes, { mode: 0o600 });
    else if (!snap.settingsExisted) fs.rmSync(settingsPath, { force: true });

    if (snap.metaExisted && snap.metaBytes !== null) writeBinaryAtomic(metaPath, snap.metaBytes, { mode: 0o600 });
    else if (!snap.metaExisted) fs.rmSync(metaPath, { force: true });

    if (!snap.themesExisted && fs.existsSync(themesDir)) {
      try {
        if (fs.readdirSync(themesDir).length === 0) fs.rmdirSync(themesDir);
      } catch {}
    }
    if (!snap.userdataExisted && fs.existsSync(targetUserdata)) {
      try {
        if (fs.readdirSync(targetUserdata).length === 0) fs.rmdirSync(targetUserdata);
      } catch {}
    }
  };

  return { commit, rollback, wasCommitted: () => committed };
}

function installThemeAt(userdataDir, options = {}) {
  const tx = prepareThemeTransaction(userdataDir, options);
  try {
    return tx.commit();
  } catch (err) {
    try { tx.rollback(); } catch {}
    throw err;
  }
}

function installTheme(options = {}) {
  return installThemeAt(getDefaultUserdataDir(), options);
}

function prepareProfileAt(userdataDir, sharedData, options = {}) {
  const result = installThemeAt(userdataDir, {
    officialOnly: options.officialOnly === true,
    activate: !sharedData,
    createSettingsIfMissing: !sharedData,
  });
  if (!sharedData && !result.activated) {
    console.warn("[提示] 主题已写入，但未能自动激活：请检查设置文件后手动切换主题");
  }
  return result;
}

function uninstallTheme(userdataDir = getDefaultUserdataDir()) {
  const { themesDir, targetThemePath, metaPath } = getThemePaths(userdataDir);
  const installed = fs.existsSync(targetThemePath);
  const meta = readThemeMeta(userdataDir);
  const bundled = getBundledThemeTexts();
  const backups = resolveBackupStack(userdataDir, meta);

  const restorePreviousThemeSetting = () => {
    const settings = readSettings(userdataDir);
    if (settings?.defaultTheme !== THEME_ID) return false;
    const shouldRestore = meta
      ? Boolean(meta.changedDefaultTheme ?? meta.hadPreviousDefaultTheme)
      : false;
    if (!shouldRestore) return false;
    if (meta?.hadPreviousDefaultTheme && meta.previousDefaultTheme && meta.previousDefaultTheme !== THEME_ID) {
      return setActiveThemeInSettings(
        meta.previousDefaultTheme,
        userdataDir,
        meta.previousDefaultThemeSetAt ?? null
      );
    }
    return setActiveThemeInSettings(null, userdataDir, meta?.previousDefaultThemeSetAt ?? null);
  };

  const liveRaw = installed ? fs.readFileSync(targetThemePath) : null;
  const liveText = liveRaw ? liveRaw.toString("utf8") : "";
  const liveParsed = liveRaw ? parseTheme(liveText) : null;
  const liveIsUnmodified = installed && isKnownUnmodifiedEnhancerTheme(liveText, liveParsed, meta, bundled);

  if (backups.length > 0) {
    let preservedPath = null;
    if (installed && !liveIsUnmodified) {
      // Never overwrite current unbacked user edits without preserving them first.
      preservedPath = path.join(themesDir, `${THEME_ID}.json.user-${Date.now()}-${randomUUID().slice(0, 6)}.before-enhancer`);
      writeBinaryAtomic(preservedPath, liveRaw);
    }
    const latest = backups.pop();
    const backupRaw = fs.readFileSync(latest.absPath);
    writeBinaryAtomic(targetThemePath, backupRaw);
    fs.unlinkSync(latest.absPath);
    const deactivated = restorePreviousThemeSetting();
    const remainingBackups = backups.map(({ file, kind, createdAt }) => ({ file, kind, createdAt }));
    if (remainingBackups.length > 0) {
      writeThemeMeta(userdataDir, {
        enhancerVersion: meta?.enhancerVersion || ENHANCER_VERSION,
        installedHashes: [],
        backups: remainingBackups,
        changedDefaultTheme: false,
        hadPreviousDefaultTheme: false,
        previousDefaultTheme: null,
        previousDefaultThemeSetAt: null,
      });
    } else {
      fs.rmSync(metaPath, { force: true });
    }
    return {
      action: "restored-backup",
      deactivated,
      targetPath: targetThemePath,
      restoredFrom: latest.absPath,
      preservedPath,
      remainingBackups: remainingBackups.map((b) => path.join(themesDir, b.file)),
    };
  }

  if (installed) {
    if (!liveIsUnmodified) {
      const deactivated = restorePreviousThemeSetting();
      fs.rmSync(metaPath, { force: true });
      return { action: "kept-custom-theme", deactivated, targetPath: targetThemePath, preservedPath: null };
    }
    fs.unlinkSync(targetThemePath);
  }
  const deactivated = restorePreviousThemeSetting();
  fs.rmSync(metaPath, { force: true });
  return { action: installed ? "removed" : "not-installed", deactivated, targetPath: targetThemePath, preservedPath: null };
}

function reportThemeUninstall(userdataDir) {
  const { action, targetPath, preservedPath, remainingBackups } = uninstallTheme(userdataDir);
  console.log(`[主题] 卸载结果：${action} (${targetPath})`);
  if (preservedPath) {
    console.log(`[主题] 当前未备份的自定义编辑已另存为：${preservedPath}`);
  }
  if (remainingBackups?.length) {
    console.log(`[主题] 仍保留更早的历史备份：${remainingBackups.join(", ")}`);
  }
}

module.exports = {
  getThemeStatus,
  formatThemeStatusText,
  getUserdataDir,
  prepareProfileAt,
  prepareThemeTransaction,
  installTheme,
  installThemeAt,
  uninstallTheme,
  reportThemeUninstall,
  extractOfficialTheme,
  LAYER_1_MARKER,
  LAYER_2_MARKER,
  SOURCE_THEME_PATH,
};
