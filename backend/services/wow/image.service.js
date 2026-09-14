/**
 * שירות תמונות — בוחר תמונות Unsplash רלוונטיות לפי תחום העסק
 * כל תמונה נבחרת לפי הקשר (hero, product, about, blog, testimonial)
 * עם גודל מותאם לשימוש
 */

// מאגר תמונות Unsplash לפי קטגוריות עסקיות
const IMAGE_DB = {
  'קוסמטיקה': {
    hero: [
      'photo-1596462502278-27bfdc403348',
      'photo-1522335789203-aabd1fc54bc9',
      'photo-1571875257727-256c39da42af',
      'photo-1505944270255-72b8c68c6a70',
    ],
    product: [
      'photo-1611930022073-b7a4ba5fcccd',
      'photo-1570194065650-d99fb4a6c084',
      'photo-1608248543803-ba4f8c70ae0b',
      'photo-1571781926291-c477ebfd024b',
      'photo-1556228578-0d85b1a4d571',
      'photo-1612817288484-6f916006741a',
    ],
    about: [
      'photo-1598440947619-2c35fc9aa908',
      'photo-1576426863848-c21f53c60b19',
      'photo-1599305090598-fe179d501227',
    ],
    blog: [
      'photo-1556228578-0d85b1a4d571',
      'photo-1598440947619-2c35fc9aa908',
      'photo-1570172619644-dfd03ed5d881',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
      'photo-1534528741775-53994a69daeb',
    ],
  },
  'טיפוח': {
    hero: [
      'photo-1596462502278-27bfdc403348',
      'photo-1522335789203-aabd1fc54bc9',
      'photo-1571875257727-256c39da42af',
      'photo-1487412912498-0447578fcca8',
    ],
    product: [
      'photo-1611930022073-b7a4ba5fcccd',
      'photo-1570194065650-d99fb4a6c084',
      'photo-1608248543803-ba4f8c70ae0b',
      'photo-1571781926291-c477ebfd024b',
    ],
    about: [
      'photo-1598440947619-2c35fc9aa908',
      'photo-1576426863848-c21f53c60b19',
    ],
    blog: [
      'photo-1556228578-0d85b1a4d571',
      'photo-1598440947619-2c35fc9aa908',
      'photo-1570172619644-dfd03ed5d881',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
    ],
  },
  'ספא': {
    hero: [
      'photo-1540555700478-4be289fbec6d',
      'photo-1544161515-4ab6ce6db874',
      'photo-1600334129128-685c5582fd35',
      'photo-1507652313519-d4e9174996dd',
    ],
    product: [
      'photo-1515377905703-c4788e51af15',
      'photo-1556228578-0d85b1a4d571',
      'photo-1611930022073-b7a4ba5fcccd',
      'photo-1570194065650-d99fb4a6c084',
    ],
    about: [
      'photo-1544161515-4ab6ce6db874',
      'photo-1540555700478-4be289fbec6d',
    ],
    blog: [
      'photo-1507652313519-d4e9174996dd',
      'photo-1600334129128-685c5582fd35',
      'photo-1544161515-4ab6ce6db874',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
    ],
  },
  'מסעדה': {
    hero: [
      'photo-1517248135467-4c7edcad34c4',
      'photo-1414235077428-338989a2e8c0',
      'photo-1555396273-367ea4eb4db5',
      'photo-1559339352-11d035aa65de',
    ],
    product: [
      'photo-1546069901-ba9599a7e63c',
      'photo-1565299624946-b28f40a0ae38',
      'photo-1540189549336-e6e99c3679fe',
      'photo-1567620905732-2d1ec7ab7445',
    ],
    about: [
      'photo-1556910103-1c02745aae4d',
      'photo-1577106263724-2c8e03bfe9cf',
    ],
    blog: [
      'photo-1476224203421-9ac39bcb3327',
      'photo-1504674900247-0877df9cc836',
      'photo-1493770348161-369560ae357d',
    ],
    person: [
      'photo-1577219491135-ce391730fb2c',
      'photo-1566554273541-37a9ca77b91f',
      'photo-1583394293214-28ez1c77f804',
    ],
  },
  'עורך דין': {
    hero: [
      'photo-1589829545856-d10d557cf95f',
      'photo-1505664194779-8beaceb93744',
      'photo-1450101499163-c8848c66ca85',
      'photo-1507679799987-c73779587ccf',
    ],
    product: [
      'photo-1589829545856-d10d557cf95f',
      'photo-1450101499163-c8848c66ca85',
      'photo-1521791055366-0d553872125f',
      'photo-1454165804606-c3d57bc86b40',
    ],
    about: [
      'photo-1507679799987-c73779587ccf',
      'photo-1521791055366-0d553872125f',
    ],
    blog: [
      'photo-1589829545856-d10d557cf95f',
      'photo-1450101499163-c8848c66ca85',
      'photo-1505664194779-8beaceb93744',
    ],
    person: [
      'photo-1560250097-0b93528c311a',
      'photo-1573496359142-b8d87734a5a2',
      'photo-1519085360753-af0119f7cbe7',
    ],
  },
  'כושר': {
    hero: [
      'photo-1534438327276-14e5300c3a48',
      'photo-1571019613454-1cb2f99b2d8b',
      'photo-1517836357463-d25dfeac3438',
      'photo-1549060279-7e168fcee0c2',
    ],
    product: [
      'photo-1517836357463-d25dfeac3438',
      'photo-1571019613454-1cb2f99b2d8b',
      'photo-1549060279-7e168fcee0c2',
      'photo-1534438327276-14e5300c3a48',
    ],
    about: [
      'photo-1571019613454-1cb2f99b2d8b',
      'photo-1534438327276-14e5300c3a48',
    ],
    blog: [
      'photo-1517836357463-d25dfeac3438',
      'photo-1549060279-7e168fcee0c2',
      'photo-1571019613454-1cb2f99b2d8b',
    ],
    person: [
      'photo-1567013127542-490d757e51fc',
      'photo-1548690312-e3b507d8c110',
      'photo-1583454110551-21f2fa2afe61',
    ],
  },
  'שיער': {
    hero: [
      'photo-1560066984-138dadb4c035',
      'photo-1521590832167-7228a0d09194',
      'photo-1562322140-8baeececf3df',
      'photo-1522337360788-8b13dee7a37e',
    ],
    product: [
      'photo-1527799820374-dcf8d9d4a388',
      'photo-1519699047748-de8e457a634e',
      'photo-1562322140-8baeececf3df',
      'photo-1560066984-138dadb4c035',
    ],
    about: [
      'photo-1560066984-138dadb4c035',
      'photo-1521590832167-7228a0d09194',
    ],
    blog: [
      'photo-1522337360788-8b13dee7a37e',
      'photo-1562322140-8baeececf3df',
      'photo-1521590832167-7228a0d09194',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
    ],
  },
  'נדל"ן': {
    hero: [
      'photo-1560518883-ce09059eeffa',
      'photo-1512917774080-9991f1c4c750',
      'photo-1570129477492-45c003edd2be',
      'photo-1582407947304-fd86f028f716',
    ],
    product: [
      'photo-1512917774080-9991f1c4c750',
      'photo-1570129477492-45c003edd2be',
      'photo-1582407947304-fd86f028f716',
      'photo-1560518883-ce09059eeffa',
    ],
    about: [
      'photo-1560518883-ce09059eeffa',
      'photo-1486406146926-c627a92ad1ab',
    ],
    blog: [
      'photo-1560518883-ce09059eeffa',
      'photo-1512917774080-9991f1c4c750',
      'photo-1570129477492-45c003edd2be',
    ],
    person: [
      'photo-1560250097-0b93528c311a',
      'photo-1573496359142-b8d87734a5a2',
      'photo-1519085360753-af0119f7cbe7',
    ],
  },
  'טיפולי פנים': {
    hero: [
      'photo-1570172619644-dfd03ed5d881',
      'photo-1616394584738-fc6e612e71b9',
      'photo-1487412912498-0447578fcca8',
      'photo-1552693673-1bf958298935',
    ],
    product: [
      'photo-1611930022073-b7a4ba5fcccd',
      'photo-1570194065650-d99fb4a6c084',
      'photo-1608248543803-ba4f8c70ae0b',
      'photo-1571781926291-c477ebfd024b',
    ],
    about: [
      'photo-1570172619644-dfd03ed5d881',
      'photo-1616394584738-fc6e612e71b9',
    ],
    blog: [
      'photo-1487412912498-0447578fcca8',
      'photo-1570172619644-dfd03ed5d881',
      'photo-1552693673-1bf958298935',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
    ],
  },
  'תיירות': {
    hero: [
      'photo-1506929562872-bb421503ef21',
      'photo-1469854523086-cc02fe5d8800',
      'photo-1476514525535-07fb3b4ae5f1',
      'photo-1507525428034-b723cf961d3e',
    ],
    product: [
      'photo-1506929562872-bb421503ef21',
      'photo-1469854523086-cc02fe5d8800',
      'photo-1476514525535-07fb3b4ae5f1',
      'photo-1507525428034-b723cf961d3e',
    ],
    about: [
      'photo-1469854523086-cc02fe5d8800',
      'photo-1476514525535-07fb3b4ae5f1',
    ],
    blog: [
      'photo-1506929562872-bb421503ef21',
      'photo-1469854523086-cc02fe5d8800',
      'photo-1507525428034-b723cf961d3e',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
    ],
  },
  'כלות': {
    hero: [
      'photo-1519741497674-611481863552',
      'photo-1594463750939-ebb28c3f7f75',
      'photo-1511285560929-80b456fea0bc',
      'photo-1465495976277-4387d4b0b4c6',
    ],
    product: [
      'photo-1519741497674-611481863552',
      'photo-1594463750939-ebb28c3f7f75',
      'photo-1511285560929-80b456fea0bc',
      'photo-1465495976277-4387d4b0b4c6',
    ],
    about: [
      'photo-1519741497674-611481863552',
      'photo-1594463750939-ebb28c3f7f75',
    ],
    blog: [
      'photo-1511285560929-80b456fea0bc',
      'photo-1465495976277-4387d4b0b4c6',
      'photo-1519741497674-611481863552',
    ],
    person: [
      'photo-1544005313-94ddf0286df2',
      'photo-1531746020798-e6953c6e8e04',
      'photo-1489424731084-a5d8b219a5bb',
    ],
  },
};

// ברירת מחדל — עסק כללי
const DEFAULT_IMAGES = {
  hero: [
    'photo-1497366216548-37526070297c',
    'photo-1497366811353-6870744d04b2',
    'photo-1504384308090-c894fdcc538d',
  ],
  product: [
    'photo-1497366216548-37526070297c',
    'photo-1504384308090-c894fdcc538d',
    'photo-1497366811353-6870744d04b2',
    'photo-1553877522-43269d4ea984',
  ],
  about: [
    'photo-1497366216548-37526070297c',
    'photo-1497366811353-6870744d04b2',
  ],
  blog: [
    'photo-1497366216548-37526070297c',
    'photo-1504384308090-c894fdcc538d',
    'photo-1553877522-43269d4ea984',
  ],
  person: [
    'photo-1544005313-94ddf0286df2',
    'photo-1531746020798-e6953c6e8e04',
    'photo-1489424731084-a5d8b219a5bb',
    'photo-1560250097-0b93528c311a',
  ],
};

// גדלי תמונה לפי תפקיד
const SIZE_MAP = {
  'hero-bg': { w: 1600, h: 900 },
  'hero-img': { w: 1200, h: 800 },
  'about-img': { w: 700, h: 700 },
  'p1-img': { w: 400, h: 500 },
  'p2-img': { w: 400, h: 500 },
  'p3-img': { w: 400, h: 500 },
  'p4-img': { w: 400, h: 500 },
  'p5-img': { w: 400, h: 500 },
  'p6-img': { w: 400, h: 500 },
  't1-img': { w: 100, h: 100 },
  't2-img': { w: 100, h: 100 },
  't3-img': { w: 100, h: 100 },
  't4-img': { w: 100, h: 100 },
  'bl1-img': { w: 500, h: 350 },
  'bl2-img': { w: 500, h: 350 },
  'bl3-img': { w: 500, h: 350 },
  'g1-img': { w: 600, h: 400 },
  'g2-img': { w: 600, h: 400 },
  'g3-img': { w: 600, h: 400 },
  'g4-img': { w: 600, h: 400 },
  'g5-img': { w: 600, h: 400 },
  'g6-img': { w: 600, h: 400 },
  'team1-img': { w: 400, h: 500 },
  'team2-img': { w: 400, h: 500 },
  'team3-img': { w: 400, h: 500 },
  'tr1-img': { w: 500, h: 400 },
  'tr2-img': { w: 500, h: 400 },
  'tr3-img': { w: 500, h: 400 },
  'tr4-img': { w: 500, h: 400 },
  'tr5-img': { w: 500, h: 400 },
  'tr6-img': { w: 500, h: 400 },
  'd1-img': { w: 600, h: 400 },
  'd2-img': { w: 600, h: 400 },
  'd3-img': { w: 600, h: 400 },
  'd4-img': { w: 600, h: 400 },
};

function getImageRole(key) {
  if (key.startsWith('hero')) return 'hero';
  if (key.startsWith('about')) return 'about';
  if (key.startsWith('bl') || key.startsWith('blog')) return 'blog';
  if (key.match(/^t\d+-img/)) return 'person';
  if (key.startsWith('team')) return 'person';
  return 'product';
}

function findCategoryImages(businessField) {
  const field = businessField.toLowerCase();
  // חיפוש התאמה מדויקת או חלקית
  for (const [cat, images] of Object.entries(IMAGE_DB)) {
    if (field.includes(cat) || cat.includes(field)) {
      return images;
    }
  }
  // חיפוש מילות מפתח
  const keywords = {
    'יופי': 'קוסמטיקה', 'beauty': 'קוסמטיקה', 'סרום': 'קוסמטיקה', 'עור': 'קוסמטיקה',
    'skincare': 'קוסמטיקה', 'cosmetic': 'קוסמטיקה',
    'spa': 'ספא', 'עיסוי': 'ספא', 'massage': 'ספא', 'מלון': 'ספא',
    'אוכל': 'מסעדה', 'שף': 'מסעדה', 'food': 'מסעדה', 'restaurant': 'מסעדה', 'קפה': 'מסעדה',
    'דין': 'עורך דין', 'law': 'עורך דין', 'legal': 'עורך דין', 'משפט': 'עורך דין',
    'gym': 'כושר', 'sport': 'כושר', 'ספורט': 'כושר', 'פילאטיס': 'כושר', 'יוגה': 'כושר',
    'hair': 'שיער', 'מספרה': 'שיער', 'salon': 'שיער', 'תספורת': 'שיער',
    'דירה': 'נדל"ן', 'בית': 'נדל"ן', 'real estate': 'נדל"ן', 'property': 'נדל"ן',
    'facial': 'טיפולי פנים', 'פנים': 'טיפולי פנים', 'פילינג': 'טיפולי פנים',
    'travel': 'תיירות', 'טיול': 'תיירות', 'חופש': 'תיירות', 'vacation': 'תיירות',
    'חתונה': 'כלות', 'bride': 'כלות', 'wedding': 'כלות', 'שמלה': 'כלות', 'סלון': 'כלות',
  };
  for (const [keyword, category] of Object.entries(keywords)) {
    if (field.includes(keyword)) {
      return IMAGE_DB[category] || DEFAULT_IMAGES;
    }
  }
  return DEFAULT_IMAGES;
}

/** יוצר URL של Unsplash עם גודל מותאם */
function buildUnsplashUrl(photoId, width, height) {
  let url = `https://images.unsplash.com/${photoId}?w=${width}&q=80&fit=crop&auto=format`;
  if (height) url += `&h=${height}`;
  return url;
}

/**
 * מחליף את כל תמונות ה-placeholder בתמונות Unsplash רלוונטיות
 * @param $ - cheerio instance
 * @param businessField - תחום העסק
 */
const injectContextualImages = ($, businessField) => {
  const images = findCategoryImages(businessField);
  const usedIndices = {
    hero: 0, product: 0, about: 0, blog: 0, person: 0,
  };

  $('[data-inject-src]').each((_, el) => {
    const $el = $(el);
    const key = $el.attr('data-inject-src');
    const role = getImageRole(key);
    const pool = images[role];
    const idx = usedIndices[role] % pool.length;
    usedIndices[role]++;

    const size = SIZE_MAP[key] || { w: 600 };
    const url = buildUnsplashUrl(pool[idx], size.w, size.h);

    if ($el.prop('tagName') === 'IMG') {
      $el.attr('src', url);
    } else {
      $el.css('background-image', `url(${url})`);
    }
  });
};

/**
 * מחזיר URL תמונה לפי תפקיד ותחום
 */
const getImageUrl = (key, businessField, index = 0) => {
  const images = findCategoryImages(businessField);
  const role = getImageRole(key);
  const pool = images[role];
  const photoId = pool[index % pool.length];
  const size = SIZE_MAP[key] || { w: 600 };
  return buildUnsplashUrl(photoId, size.w, size.h);
};

module.exports = {
  injectContextualImages,
  getImageUrl,
};
