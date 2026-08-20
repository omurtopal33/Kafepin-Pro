"use strict";

module.exports = function createFeeUtils(options = {}) {
  const vipSet = new Set((options.VIP_MASALAR || []).map(Number));
  const normalOpening = Math.max(0, Number(options.NORMAL_OPENING) || 0);
  const vipOpening = Math.max(0, Number(options.VIP_OPENING) || 0);
  const normalBase = Math.max(0, Number(options.NORMAL_SAAT) || normalOpening);
  const vipBase = Math.max(0, Number(options.VIP_SAAT) || vipOpening);
  const normalIncrease = Math.max(0, Number(options.NORMAL_ARTIS) || 0);
  const vipIncrease = Math.max(0, Number(options.VIP_ARTIS) || 0);
  const openingMinutes = Math.max(1, Number(options.OPENING_MINUTES) || 60);
  const increaseBlockMinutes = Math.max(1, Number(options.INCREASE_BLOCK_MINUTES) || 30);

  function getPricingForTs(masa) {
    const isVip = vipSet.has(Number(masa));
    return {
      isVip,
      opening: isVip ? vipOpening : normalOpening,
      base: isVip ? vipBase : normalBase,
      inc: isVip ? vipIncrease : normalIncrease,
      sure30: isVip ? 35 : 25
    };
  }

  function calcRealFee(masa, minutes) {
    const value = Math.max(0, Number(minutes) || 0);
    if (value <= 0) return 0;
    const pricing = getPricingForTs(masa);
    if (value <= openingMinutes) return pricing.opening;
    return pricing.opening + Math.ceil((value - openingMinutes) / increaseBlockMinutes) * pricing.inc;
  }

  function feeAtTime(masa, startTime, endTime) {
    const start = Number(startTime) || 0;
    const end = Number(endTime) || 0;
    if (!start || !end || end <= start) return 0;
    return calcRealFee(masa, (end - start) / 60000);
  }

  return { getPricingForTs, calcRealFee, feeAtTime };
};
