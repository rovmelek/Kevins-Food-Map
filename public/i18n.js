'use strict';
// Texts a visitor sees, in English and Traditional Chinese (Taiwan). Restaurant
// names and addresses are stored data, and the Manage window is English only,
// so neither is here. A value is a string with {name} placeholders, or in English
// a pair [one, other] picked by the placeholder {n}. Loaded before app.js, which
// has t() and the language choice; the test also loads this file in Node.

const MESSAGES = {
  en: {
    title: "Kevin's Food Map",
    switchLang: 'Switch to Traditional Chinese (中文)',
    searchPlaceholder: 'Search by name',
    search: 'Search',
    closeSearch: 'Close search',
    country: 'Country',
    allCountries: 'All countries',
    countryUnknown: 'Country unknown',
    filter: 'Filter',
    filterByType: 'Filter by food type',
    filterByTypeN: 'Filter by food type, {n} selected',
    foodTypes: 'Food types',
    clear: 'Clear',
    removeFilter: 'Remove filter {type}',
    noRestaurantsYet: 'No restaurants yet.',
    manage: 'Manage',
    showMap: 'Show map',
    showList: 'Show list',
    restaurants: 'Restaurants',
    restaurantCount: ['{n} restaurant', '{n} restaurants'],
    restaurantCountSr: [', {n} restaurant', ', {n} restaurants'],
    shownOf: '{n} of {total} shown',
    noMatch: 'No restaurants match.',
    emptyList: 'No restaurants yet. Use “Manage” to add Google Maps links.',
    phoneNA: 'Phone not available',
    addressNA: 'Address not available',
    sortedFromYou: 'Sorted by distance from your location.',
    sortedFrom: 'Sorted by distance from {place}. {button}',
    useMyLocation: 'Use my location',
    locUnsupported: 'This browser can’t share its location.',
    locDenied: 'Location permission was denied.',
    locFailed: 'Couldn’t get your location.',
    ft: '{n} ft',
    mi: '{n} mi',
    ratingLabel: 'Google rating {rating} out of 5',
    ratingLabelReviews: 'Google rating {rating} out of 5, {count} reviews',
    ratingNote: "Ratings from Google Maps. Google doesn't verify reviews but removes fake ones it finds.",
    aboutReviews: 'About reviews',
    openInMaps: 'Open in Google Maps',
    mapOffTitle: 'Map not configured.',
    mapOffBody: 'Set GOOGLE_MAPS_API_KEY in .env and restart the server.',
    listStillWorks: 'The list on the left still works.',
    mapFailed: 'Could not load Google Maps. Check your connection, then reload the page.',
    mapRejectedTitle: 'Google rejected the Maps API key.',
    mapRejectedBody: "Check that billing and Maps JavaScript API are enabled, and that the key's Websites restriction includes {origin}. The browser console (F12) names the exact error.",
    mapStartFailed: 'The map failed to start.',
    loadFailed: 'Could not load: {message}',
  },
  'zh-TW': {
    title: 'Kevin 的美食地圖',
    switchLang: '切換為英文 (EN)',
    searchPlaceholder: '依名稱搜尋',
    search: '搜尋',
    closeSearch: '關閉搜尋',
    country: '國家',
    allCountries: '所有國家',
    countryUnknown: '國家不明',
    filter: '篩選',
    filterByType: '依料理類型篩選',
    filterByTypeN: '依料理類型篩選，已選 {n} 項',
    foodTypes: '料理類型',
    clear: '清除',
    removeFilter: '移除篩選：{type}',
    noRestaurantsYet: '尚無餐廳。',
    manage: '管理',
    showMap: '顯示地圖',
    showList: '顯示清單',
    restaurants: '餐廳',
    restaurantCount: '{n} 家餐廳',
    restaurantCountSr: '，{n} 家餐廳',
    shownOf: '共 {total}，顯示 {n} 家',
    noMatch: '沒有符合的餐廳。',
    emptyList: '尚無餐廳。請使用「管理」新增 Google 地圖連結。',
    phoneNA: '電話未提供',
    addressNA: '地址未提供',
    sortedFromYou: '依與您所在位置的距離排序。',
    sortedFrom: '依與 {place} 的距離排序。{button}',
    useMyLocation: '使用我的位置',
    locUnsupported: '此瀏覽器無法分享位置。',
    locDenied: '位置權限已被拒絕。',
    locFailed: '無法取得您的位置。',
    ft: '{n} 英尺',
    mi: '{n} 英里',
    ratingLabel: 'Google 評分 {rating}（滿分 5 分）',
    ratingLabelReviews: 'Google 評分 {rating}（滿分 5 分），共 {count} 則評論',
    ratingNote: '評分來自 Google 地圖。Google 不會驗證評論，但會移除其發現的不實評論。',
    aboutReviews: '關於評論',
    openInMaps: '在 Google 地圖中開啟',
    mapOffTitle: '尚未設定地圖。',
    mapOffBody: '請在 .env 中設定 GOOGLE_MAPS_API_KEY，然後重新啟動伺服器。',
    listStillWorks: '左側的清單仍可使用。',
    mapFailed: '無法載入 Google 地圖。請檢查網路連線，然後重新整理頁面。',
    mapRejectedTitle: 'Google 拒絕了地圖 API 金鑰。',
    mapRejectedBody: '請確認已啟用計費與 Maps JavaScript API，且金鑰的「網站」限制包含 {origin}。瀏覽器主控台 (F12) 會顯示確切的錯誤。',
    mapStartFailed: '地圖無法啟動。',
    loadFailed: '無法載入：{message}',
  },
};

// Food types are stored as English words ("Japanese", "Fast food", or whatever
// was typed in Manage). Only the known ones are translated; anything else shows
// as stored. Filtering always uses the stored value.
const FOOD_TYPES = {
  'zh-TW': {
    Japanese: '日式料理', Chinese: '中式料理', Korean: '韓式料理', Thai: '泰式料理', Vietnamese: '越南料理',
    Indian: '印度料理', Italian: '義式料理', Mexican: '墨西哥料理', Pizza: '披薩', Burgers: '漢堡',
    Barbecue: '燒烤', Cafe: '咖啡廳', Drinks: '飲料', Bakery: '麵包店', Seafood: '海鮮',
    Steakhouse: '牛排館', Sandwiches: '三明治', Vegetarian: '素食', Breakfast: '早餐', Dessert: '甜點',
    Dumpling: '餃子', Noodles: '麵食', 'Middle Eastern': '中東料理', Mediterranean: '地中海料理',
    Greek: '希臘料理', French: '法式料理', American: '美式料理', 'Fast food': '速食',
    Taiwanese: '台灣料理', German: '德式料理', Lebanese: '黎巴嫩料理', Turkish: '土耳其料理',
    Spanish: '西班牙料理', Brazilian: '巴西料理', Indonesian: '印尼料理', Filipino: '菲律賓料理',
    Hawaiian: '夏威夷料理', Afghani: '阿富汗料理', African: '非洲料理', Ethiopian: '衣索比亞料理',
    Peruvian: '秘魯料理', Cuban: '古巴料理', Caribbean: '加勒比海料理', Nepali: '尼泊爾料理',
    Pakistani: '巴基斯坦料理', Other: '其他',
  },
};

// The first language in the browser's list that is English or Traditional
// Chinese (zh-TW, zh-HK, zh-MO, zh-Hant…, yue-Hant…) decides; anything else,
// plain "zh" included, gets English.
function detectLang(languages) {
  for (const tag of languages || []) {
    if (/^(zh-(tw|hk|mo|hant)|yue-hant)(-|$)/i.test(tag)) return 'zh-TW';
    if (/^en(-|$)/i.test(tag)) return 'en';
  }
  return 'en';
}

if (typeof module !== 'undefined') module.exports = { MESSAGES, FOOD_TYPES, detectLang };
