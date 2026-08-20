"use strict";

module.exports = function createSpinService(options = {}) {
  const getPricingForTs = typeof options.getPricingForTs === "function"
    ? options.getPricingForTs
    : (masa => ({ isVip: false }));
  const itemCost = Math.max(0, Number(options.ICECEK_MALIYET) || 20);

  function weightedRandom(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return null;
    let total = 0;
    list.forEach(item => { total += Math.max(0, Number(item && item.weight) || 0); });
    if (!(total > 0)) return list[0];
    let rand = Math.random() * total;
    for (const item of list) {
      const weight = Math.max(0, Number(item && item.weight) || 0);
      if (rand < weight) return item;
      rand -= weight;
    }
    return list[0];
  }

  function getRewardCostAndType(masa, rewardName) {
    const reward = String(rewardName || "").toLocaleLowerCase("tr-TR");
    const pricing = getPricingForTs(Number(masa) || 0) || {};
    const isVip = pricing.isVip === true;

    if (reward.includes("dakika")) {
      const match = reward.match(/(\d+)\s*dakika/);
      const minutes = match ? Math.max(0, parseInt(match[1], 10) || 0) : 0;
      const per30 = isVip ? 35 : 25;
      let amount = 0;
      if (minutes === 30) amount = per30;
      else if (minutes === 60) amount = per30 * 2;
      else if (minutes > 0) amount = Math.ceil(minutes / 30) * per30;
      return { amount, kind: "time" };
    }

    const itemKeywords = [
      "kola", "çay", "cay", "soda", "crax", "gofret", "enerji", "anahtarlık", "anahtarlik"
    ];
    if (itemKeywords.some(keyword => reward.includes(keyword))) {
      return { amount: itemCost, kind: "item" };
    }

    return { amount: 0, kind: "none" };
  }

  function isBigReward(rewardName) {
    return String(rewardName || "").toLocaleLowerCase("tr-TR").includes("60 dakika");
  }

  return { weightedRandom, getRewardCostAndType, isBigReward };
};
