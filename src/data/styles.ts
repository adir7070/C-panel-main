export interface StyleDef {
  id: string;
  label: string;
  vibe: string;
  swatches: [string, string, string];
  dark?: boolean;
  category: "minimal" | "luxury" | "bold" | "tech" | "nature";
}

export const STYLES: StyleDef[] = [
  { id:"mindful-gradient", label:"גרדיאנט רגוע",   vibe:"לבנדר, פסטל, מדיטציה",         swatches:["#F5F0FF","#7C3AED","#F97316"],                  category:"nature"  },
  { id:"modern",           label:"מודרני",          vibe:"נקי, מקצועי, אוניברסלי",      swatches:["#FAFAFA","#111111","#6366F1"],                  category:"minimal" },
  { id:"minimalist",       label:"מינימליסטי",      vibe:"פשוט ככל האפשר",               swatches:["#FFFFFF","#111111","#E5E7EB"],                  category:"minimal" },
  { id:"classic",          label:"יוקרה שחור-זהב", vibe:"פרמיום, אלגנטי, דרמטי",        swatches:["#0D0D0D","#C9A843","#F0E6D0"], dark:true,        category:"luxury"  },
  { id:"elegant",          label:"אלגנטי נשי",      vibe:"ורוד-חום, עדין",               swatches:["#FDF8F5","#B08870","#D4A8A0"],                  category:"luxury"  },
  { id:"editorial",        label:"מגזיני",          vibe:"Vogue, א-סימטרי",              swatches:["#FAFAF8","#000000","#888888"],                  category:"minimal" },
  { id:"neo-brutalism",    label:"ברוטליזם",        vibe:"ניאון, גבולות עבים",            swatches:["#FFFFFF","#BFFF00","#FF6B6B"],                  category:"bold"    },
  { id:"glassmorphism",    label:"זכוכית עתידנית",  vibe:"SaaS, AI, כהה ונקי",           swatches:["#0D0D1F","#6366F1","#A855F7"], dark:true,        category:"tech"    },
  { id:"cyberpunk",        label:"סייברפאנק",       vibe:"ניאון, גליץ׳, עתידני",          swatches:["#080815","#00FFFF","#FF2D95"], dark:true,        category:"bold"    },
  { id:"organic",          label:"אורגני",          vibe:"אדמה, בוהו, רך",               swatches:["#F5EFE6","#5C7A5C","#C9A84C"],                  category:"nature"  },
  { id:"japandi",          label:"יפנדי",           vibe:"עץ וחימר, מזרחי-סקנדינבי",    swatches:["#F7F2EB","#8B7355","#5C4D3C"],                  category:"nature"  },
  { id:"bento",            label:"בנטו",            vibe:"ווידג׳טים מודולריים",          swatches:["#F4F4F5","#7C3AED","#F97316"],                  category:"minimal" },
  { id:"retro-70s",        label:"רטרו 70׳",        vibe:"כתום גרובי, וינטג׳",            swatches:["#F5E8D5","#C97040","#5C6B3A"],                  category:"bold"    },
  { id:"tropical-luxury",  label:"טרופי יוקרתי",    vibe:"ג׳ונגל כהה, זהב",               swatches:["#0F2D1F","#D4A843","#065F46"], dark:true,        category:"luxury"  },
  { id:"fintech",          label:"פיננסי",          vibe:"כחול אמין, מקצועי",            swatches:["#F8FAFF","#1D4ED8","#10B981"],                  category:"tech"    },
  { id:"solarpunk",        label:"סולארפאנק",       vibe:"ירוק צומח, זכוכית ואור",       swatches:["#ECFDF5","#059669","#D4A843"],                  category:"nature"  },
];

export const STYLE_CATS = [
  { id: "all",     label: "הכל"      },
  { id: "minimal", label: "נקי"      },
  { id: "luxury",  label: "יוקרה"   },
  { id: "bold",    label: "נועז"     },
  { id: "tech",    label: "טכנולוגי" },
  { id: "nature",  label: "טבעי"    },
];

export function styleById(id: string | undefined): StyleDef | undefined {
  return id ? STYLES.find(s => s.id === id) : undefined;
}
