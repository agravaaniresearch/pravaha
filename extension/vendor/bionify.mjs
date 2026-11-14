// Word-splitting rules ported from Bionify (https://github.com/Cveinnt/bionify, src/utils.js),
// Copyright Vincent Wu, licensed under the GNU GPL v3 (see bionify.LICENSE.txt).
//
// The rules are unchanged: default size table "0 1 1 2", rest ratio 0.4 (so 5+ letter words
// bold ceil(0.4 * length) letters), words of three letters or fewer in the common-word list are
// left alone (the match is case sensitive, as upstream), and text nodes of 20 characters or
// fewer are not touched.
//
// Differences from upstream, all about how the result is delivered and none about what is bolded:
//  - Upstream builds an HTML string and assigns it with innerHTML. Here the functions return
//    plain [bold, rest] pieces so the caller can attach DOM nodes and never parse HTML.
//  - Upstream appends a trailing space after every text node. That is not reproduced, because
//    it would insert spaces before inline tags such as <em>.
//  - Upstream reads its settings from chrome.storage. Here they are passed in.

export const defaultAlgorithm = "- 0 1 1 2 0.4";

// parseAlgorithm: verbatim apart from the signature.
export function parseAlgorithm(algorithm) {
  try {
    var res = { exclude: true, sizes: [], restRatio: 0.4 };
    let parts = algorithm.split(" ");
    if (parts[0] == "+") res.exclude = false;
    res.restRatio = Number(parts[parts.length - 1]);
    for (var i = 1; i < parts.length - 1; i++) res.sizes.push(parts[i]);
    return res;
  } catch {
    return { exclude: true, sizes: [1, 1, 2], restRatio: 0.4 };
  }
}

export const commonWords = ["the", "be", "to", "of", "and", "a", "an", "it", "at", "on", "he", "she", "but", "is", "my"];

// bionifyWord: same decisions as upstream's bionifyifyWord. Returns [highlight, rest], or null
// where upstream returns the word unchanged (a short common word).
export function bionifyWord(word, algorithm) {
  const isCommon = (w) => commonWords.indexOf(w) != -1;
  var index = word.length - 1;
  var numBold = 1;
  if (word.length <= 3 && algorithm.exclude) { if (isCommon(word)) return null; }
  if (index < algorithm.sizes.length) numBold = algorithm.sizes[index]; else numBold = Math.ceil(word.length * algorithm.restRatio);
  return [word.slice(0, numBold), word.slice(numBold)];
}

// bionifyText: splits on single spaces exactly as upstream and returns a list of
// {text, kind} pieces where kind is "highlight", "rest" or "plain" (a word left alone).
export function bionifyText(text, algorithm) {
  if (text.length < 10) return [{ text, kind: "plain" }];
  const out = []; const words = text.split(" ");
  words.forEach((word, i) => {
    const w = bionifyWord(word, algorithm);
    if (!w) out.push({ text: word, kind: "plain" });
    else { if (w[0]) out.push({ text: w[0], kind: "highlight" }); if (w[1]) out.push({ text: w[1], kind: "rest" }); }
    if (i < words.length - 1) out.push({ text: " ", kind: "plain" });
  });
  return out;
}

// Upstream only replaces text nodes longer than this.
export const MIN_NODE_LENGTH = 20;
