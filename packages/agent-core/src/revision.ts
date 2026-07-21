import type {
  ContentChannel,
  ContentPackageContent,
  RevisionDependencyInput,
  RevisionDependencyResult,
} from "./types.js";

export const ALL_CONTENT_CHANNELS: ContentChannel[] = ["H", "N.imageBrief", "N.title", "N.body", "Cref"];

const DEPENDENCIES: Record<ContentChannel, ContentChannel[]> = {
  H: [],
  // A changed visual promise can alter what the title, body and residual
  // comment questions must explain. This dependency is semantic, not proof
  // that a planned image has already been produced.
  "N.imageBrief": ["N.title", "N.body", "Cref"],
  "N.title": ["N.body", "Cref"],
  "N.body": ["Cref"],
  Cref: [],
};

const PRESENTATION_ONLY = /(\u66f4\u77ed|\u7cbe\u7b80|\u53e3\u8bed|\u8bed\u6c14|\u6da6\u8272|\u9519\u522b\u5b57|\u6807\u70b9|\u6392\u7248|shorter|tone|proofread|format)/iu;
const GLOBAL_CHANGE = /(\u4e8b\u5b9e|\u77e5\u8bc6|\u4f9d\u636e|\u9879\u76ee|\u4ea7\u54c1|\u533b\u751f|\u57ce\u5e02|\u53d7\u4f17|\u4eba\u7fa4|\u9636\u6bb5|\u5165\u53e3|\u76ee\u6807|\u6574\u4f53|\u5168\u90e8|fact|knowledge|audience|goal|project)/iu;

function inferChannels(instruction: string): ContentChannel[] {
  const channels = new Set<ContentChannel>();
  if (/(\u6807\u7b7e|\u8bdd\u9898|hashtag|tags?)/iu.test(instruction)) channels.add("H");
  if (/(\u56fe\u7247|\u5c01\u9762|\u89c6\u89c9|image|cover)/iu.test(instruction)) channels.add("N.imageBrief");
  if (/(\u6807\u9898|title)/iu.test(instruction)) channels.add("N.title");
  if (/(\u6b63\u6587|\u5185\u5bb9|body|copy)/iu.test(instruction)) channels.add("N.body");
  if (/(\u8bc4\u8bba|\u95ee\u7b54|\u8ffd\u95ee|comment|faq|q&a)/iu.test(instruction)) channels.add("Cref");
  // A fact may be edited inside one explicitly named channel. Only broaden to the
  // whole package when no concrete channel was selected (or audience/task scope changed).
  if (GLOBAL_CHANGE.test(instruction) && (channels.size === 0 || /(\u9879\u76ee|\u4ea7\u54c1|\u533b\u751f|\u57ce\u5e02|\u53d7\u4f17|\u4eba\u7fa4|\u9636\u6bb5|\u5165\u53e3|\u76ee\u6807|\u6574\u4f53|\u5168\u90e8|audience|goal|project)/iu.test(instruction))) {
    return [...ALL_CONTENT_CHANNELS];
  }
  if (!channels.size) channels.add("N.body");
  return [...channels];
}

export function analyzeRevisionDependencies(input: RevisionDependencyInput): RevisionDependencyResult {
  const directChannels = [...new Set(input.explicitChannels?.length ? input.explicitChannels : inferChannels(input.instruction))];
  const downstream = new Set<ContentChannel>();
  const reasons: string[] = [];
  const presentationOnly = PRESENTATION_ONLY.test(input.instruction);
  if (directChannels.length === ALL_CONTENT_CHANNELS.length) {
    reasons.push("The instruction changes project facts, audience, entry, goal or the whole package.");
  } else if (presentationOnly) {
    reasons.push("The instruction is presentation-only, so semantically independent channels are preserved.");
  } else {
    const visit = (channel: ContentChannel): void => {
      for (const dependent of DEPENDENCIES[channel]) {
        if (!directChannels.includes(dependent) && !downstream.has(dependent)) {
          downstream.add(dependent);
          visit(dependent);
        }
      }
    };
    directChannels.forEach(visit);
    if (directChannels.includes("N.title") && downstream.has("N.body")) reasons.push("A changed title promise must remain consistent with the body and residual comment questions.");
    if (directChannels.includes("N.imageBrief") && downstream.has("N.title")) reasons.push("A changed image or cover promise must be reconciled with the title, body and residual comment questions.");
    if (directChannels.includes("N.body") && downstream.has("Cref")) reasons.push("A changed body changes which information gaps remain for the comment reference section.");
    if (!downstream.size) reasons.push("The selected channel has no semantic downstream dependency.");
  }
  const downstreamChannels = [...downstream];
  const rerunChannels = ALL_CONTENT_CHANNELS.filter((channel) => directChannels.includes(channel) || downstream.has(channel));
  return {
    directChannels: ALL_CONTENT_CHANNELS.filter((channel) => directChannels.includes(channel)),
    downstreamChannels: ALL_CONTENT_CHANNELS.filter((channel) => downstreamChannels.includes(channel)),
    rerunChannels,
    preservedChannels: ALL_CONTENT_CHANNELS.filter((channel) => !rerunChannels.includes(channel)),
    semanticChange: !presentationOnly,
    reasons,
  };
}

export function mergeContentByChannels(
  original: ContentPackageContent,
  regenerated: ContentPackageContent,
  channels: ContentChannel[],
): ContentPackageContent {
  const selected = new Set(channels);
  return {
    H: selected.has("H") ? regenerated.H : original.H,
    N: {
      imageBrief: selected.has("N.imageBrief") ? regenerated.N.imageBrief : original.N.imageBrief,
      title: selected.has("N.title") ? regenerated.N.title : original.N.title,
      body: selected.has("N.body") ? regenerated.N.body : original.N.body,
    },
    Cref: selected.has("Cref") ? regenerated.Cref : original.Cref,
  };
}
