import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'ur' | 'ar';
export const RTL: Record<Lang, boolean> = { en: false, ur: true, ar: true };
export const LANG_LABEL: Record<Lang, string> = { en: 'English', ur: 'اردو', ar: 'العربية' };

const dict = {
  en: {
    menu: 'Menu', search: 'Search dishes…', all: 'All', featured: "Chef's picks", addToCart: 'Add to order', add: 'Add',
    cart: 'Your order', emptyCart: 'Your order is empty', emptyCartHint: 'Browse the menu and add something delicious.',
    checkout: 'Place order', subtotal: 'Subtotal', discount: 'Discount', service: 'Service charge', tax: 'Tax', total: 'Total',
    estimate: 'Final amount is confirmed by the restaurant when you place the order.', table: 'Table', dineIn: 'Dine-in', takeaway: 'Takeaway',
    delivery: 'Delivery', pickup: 'Pickup', deliveryAddress: 'Delivery address', deliveryFee: 'Delivery fee', needAddress: 'Please enter your delivery address and phone number.', yourName: 'Your name', phone: 'Phone number', notes: 'Notes for the kitchen', coupon: 'Coupon code', apply: 'Apply', deliveryArea: 'Delivery area', chooseArea: 'Choose your area', shareLocation: 'Use my location', locationShared: 'Location shared', locationFailed: 'Could not get your location', minOrderArea: 'Minimum order for this area', consentMarketing: 'Send me offers by SMS/WhatsApp/email (you can opt out any time)', deliveryCode: 'Delivery code (give it to the rider)', riderLabel: 'Rider', dueBy: 'Expected by', unsubTitle: 'Unsubscribe', unsubDone: 'You will not receive marketing messages from us any more.', unsubConfirm: 'Stop marketing messages',
    soldOut: 'Sold out', chooseOption: 'Choose an option', extras: 'Extras', quantity: 'Quantity', orderPlaced: 'Order placed!',
    trackOrder: 'Track your order', orderNo: 'Order', status: 'Status', payment: 'Payment', payCash: 'Pay at the counter / to your waiter',
    payOnline: 'Pay online now', reserve: 'Book a table', reserveTitle: 'Reserve a table', partySize: 'Guests', dateTime: 'Date & time',
    submit: 'Submit', reservationSent: 'Request received! We will confirm shortly.', rate: 'Rate your experience', thanks: 'Thank you for your feedback!',
    scanAgain: 'Scan the QR code on your table to order.', orderingClosed: 'Online ordering is currently unavailable.', viewMenu: 'View menu',
    hours: 'Opening hours', reviews: 'What guests say', back: 'Back', continue: 'Continue', remove: 'Remove', items: 'items', orderType: 'Order type',
    st_pending: 'Received — waiting for confirmation', st_accepted: 'Confirmed by the restaurant', st_preparing: 'Being prepared', st_partially_ready: 'Partly ready',
    st_ready: 'Ready!', st_delivered: 'Served — enjoy!', st_completed: 'Completed', st_rejected: 'Declined by the restaurant', st_cancelled: 'Cancelled', st_refunded: 'Refunded',
    pay_unpaid: 'Not paid yet', pay_partially_paid: 'Partly paid', pay_paid: 'Paid', pay_partially_refunded: 'Partly refunded', pay_refunded: 'Refunded',
    live: 'Live updates', send: 'Send', comment: 'Comments (optional)', notFound: 'We could not find that restaurant.', menuEmpty: 'The menu is being prepared — please check back soon.', noResults: 'No dishes match your search.', unavailable: 'This restaurant is temporarily unavailable.', offers: 'Today’s offers', from: 'from', visit: 'Visit us', browseMenu: 'Explore the menu', call: 'Call', addedToCart: 'Added to your order', viewOrder: 'View order', guestRating: 'Guest rating', ourMenu: 'Our menu', dishes: 'dishes', dish: 'dish',
  },
  ur: {
    menu: 'مینو', search: 'کھانا تلاش کریں…', all: 'سب', featured: 'خاص پکوان', addToCart: 'آرڈر میں شامل کریں', add: 'شامل کریں',
    cart: 'آپ کا آرڈر', emptyCart: 'آپ کا آرڈر خالی ہے', emptyCartHint: 'مینو دیکھیں اور کچھ مزیدار شامل کریں۔',
    checkout: 'آرڈر دیں', subtotal: 'ذیلی کل', discount: 'رعایت', service: 'سروس چارج', tax: 'ٹیکس', total: 'کل',
    estimate: 'حتمی رقم آرڈر دینے پر ریسٹورنٹ کی جانب سے تصدیق ہوگی۔', table: 'میز', dineIn: 'یہیں کھائیں', takeaway: 'ساتھ لے جائیں',
    delivery: 'ڈلیوری', pickup: 'خود وصول کریں', deliveryAddress: 'ڈلیوری کا پتہ', deliveryFee: 'ڈلیوری چارج', needAddress: 'براہِ کرم ڈلیوری کا پتہ اور فون نمبر درج کریں۔', yourName: 'آپ کا نام', phone: 'فون نمبر', notes: 'باورچی خانے کے لیے ہدایات', coupon: 'کوپن کوڈ', apply: 'لاگو کریں', deliveryArea: 'ڈلیوری کا علاقہ', chooseArea: 'اپنا علاقہ منتخب کریں', shareLocation: 'میرا مقام استعمال کریں', locationShared: 'مقام شیئر ہو گیا', locationFailed: 'آپ کا مقام نہیں مل سکا', minOrderArea: 'اس علاقے کے لیے کم از کم آرڈر', consentMarketing: 'مجھے SMS/WhatsApp/ای میل پر آفرز بھیجیں (کسی بھی وقت بند کر سکتے ہیں)', deliveryCode: 'ڈلیوری کوڈ (رائیڈر کو بتائیں)', riderLabel: 'رائیڈر', dueBy: 'متوقع وقت', unsubTitle: 'ان سبسکرائب', unsubDone: 'اب آپ کو ہماری طرف سے مارکیٹنگ پیغامات نہیں آئیں گے۔', unsubConfirm: 'مارکیٹنگ پیغامات بند کریں',
    soldOut: 'ختم', chooseOption: 'ایک انتخاب کریں', extras: 'اضافی', quantity: 'تعداد', orderPlaced: 'آرڈر موصول ہو گیا!',
    trackOrder: 'اپنا آرڈر دیکھیں', orderNo: 'آرڈر', status: 'حالت', payment: 'ادائیگی', payCash: 'کاؤنٹر / ویٹر کو ادائیگی کریں',
    payOnline: 'ابھی آن لائن ادائیگی کریں', reserve: 'میز بک کریں', reserveTitle: 'میز ریزرو کریں', partySize: 'مہمان', dateTime: 'تاریخ و وقت',
    submit: 'بھیجیں', reservationSent: 'درخواست موصول ہو گئی! ہم جلد تصدیق کریں گے۔', rate: 'اپنا تجربہ بتائیں', thanks: 'آپ کی رائے کا شکریہ!',
    scanAgain: 'آرڈر کے لیے میز پر موجود QR کوڈ اسکین کریں۔', orderingClosed: 'آن لائن آرڈر فی الحال دستیاب نہیں۔', viewMenu: 'مینو دیکھیں',
    hours: 'اوقات کار', reviews: 'مہمانوں کی رائے', back: 'واپس', continue: 'جاری رکھیں', remove: 'ہٹائیں', items: 'اشیاء', orderType: 'آرڈر کی قسم',
    st_pending: 'موصول — تصدیق کا انتظار', st_accepted: 'ریسٹورنٹ نے تصدیق کر دی', st_preparing: 'تیار ہو رہا ہے', st_partially_ready: 'جزوی تیار',
    st_ready: 'تیار!', st_delivered: 'پیش کر دیا گیا', st_completed: 'مکمل', st_rejected: 'ریسٹورنٹ نے مسترد کر دیا', st_cancelled: 'منسوخ', st_refunded: 'رقم واپس',
    pay_unpaid: 'ابھی ادا نہیں ہوا', pay_partially_paid: 'جزوی ادائیگی', pay_paid: 'ادا شدہ', pay_partially_refunded: 'جزوی واپسی', pay_refunded: 'رقم واپس',
    live: 'براہ راست', send: 'بھیجیں', comment: 'تبصرہ (اختیاری)', notFound: 'یہ ریسٹورنٹ نہیں ملا۔', menuEmpty: 'مینو تیار کیا جا رہا ہے — براہ کرم جلد دوبارہ دیکھیں۔', noResults: 'آپ کی تلاش سے کوئی کھانا نہیں ملا۔', unavailable: 'یہ ریسٹورنٹ عارضی طور پر دستیاب نہیں۔', offers: 'آج کی پیشکش', from: 'سے شروع', visit: 'ہم سے ملیں', browseMenu: 'مینو دیکھیں', call: 'کال کریں', addedToCart: 'آرڈر میں شامل کر دیا گیا', viewOrder: 'آرڈر دیکھیں', guestRating: 'مہمانوں کی ریٹنگ', ourMenu: 'ہمارا مینو', dishes: 'کھانے', dish: 'کھانا',
  },
  ar: {
    menu: 'القائمة', search: 'ابحث عن طبق…', all: 'الكل', featured: 'اختيارات الشيف', addToCart: 'أضف إلى الطلب', add: 'أضف',
    cart: 'طلبك', emptyCart: 'طلبك فارغ', emptyCartHint: 'تصفح القائمة وأضف شيئاً لذيذاً.',
    checkout: 'إرسال الطلب', subtotal: 'المجموع الفرعي', discount: 'الخصم', service: 'رسوم الخدمة', tax: 'الضريبة', total: 'الإجمالي',
    estimate: 'يؤكد المطعم المبلغ النهائي عند إرسال الطلب.', table: 'الطاولة', dineIn: 'تناول في المطعم', takeaway: 'سفري',
    delivery: 'توصيل', pickup: 'استلام', deliveryAddress: 'عنوان التوصيل', deliveryFee: 'رسوم التوصيل', needAddress: 'يرجى إدخال عنوان التوصيل ورقم الهاتف.', yourName: 'اسمك', phone: 'رقم الهاتف', notes: 'ملاحظات للمطبخ', coupon: 'رمز القسيمة', apply: 'تطبيق', deliveryArea: 'منطقة التوصيل', chooseArea: 'اختر منطقتك', shareLocation: 'استخدم موقعي', locationShared: 'تمت مشاركة الموقع', locationFailed: 'تعذر تحديد موقعك', minOrderArea: 'الحد الأدنى للطلب لهذه المنطقة', consentMarketing: 'أرسلوا لي العروض عبر الرسائل/واتساب/البريد (يمكنك الإلغاء في أي وقت)', deliveryCode: 'رمز التوصيل (أعطه للمندوب)', riderLabel: 'المندوب', dueBy: 'الوقت المتوقع', unsubTitle: 'إلغاء الاشتراك', unsubDone: 'لن تصلك رسائل تسويقية منا بعد الآن.', unsubConfirm: 'إيقاف الرسائل التسويقية',
    soldOut: 'نفدت الكمية', chooseOption: 'اختر خياراً', extras: 'إضافات', quantity: 'الكمية', orderPlaced: 'تم استلام الطلب!',
    trackOrder: 'تتبع طلبك', orderNo: 'طلب', status: 'الحالة', payment: 'الدفع', payCash: 'الدفع عند الكاشير / للنادل',
    payOnline: 'ادفع الآن عبر الإنترنت', reserve: 'احجز طاولة', reserveTitle: 'حجز طاولة', partySize: 'الضيوف', dateTime: 'التاريخ والوقت',
    submit: 'إرسال', reservationSent: 'تم استلام الطلب! سنؤكد قريباً.', rate: 'قيّم تجربتك', thanks: 'شكراً لملاحظاتك!',
    scanAgain: 'امسح رمز QR الموجود على طاولتك للطلب.', orderingClosed: 'الطلب عبر الإنترنت غير متاح حالياً.', viewMenu: 'عرض القائمة',
    hours: 'ساعات العمل', reviews: 'آراء الضيوف', back: 'رجوع', continue: 'متابعة', remove: 'إزالة', items: 'عناصر', orderType: 'نوع الطلب',
    st_pending: 'تم الاستلام — بانتظار التأكيد', st_accepted: 'أكد المطعم الطلب', st_preparing: 'قيد التحضير', st_partially_ready: 'جاهز جزئياً',
    st_ready: 'جاهز!', st_delivered: 'تم التقديم — بالهناء', st_completed: 'مكتمل', st_rejected: 'رفض المطعم الطلب', st_cancelled: 'ملغى', st_refunded: 'مسترد',
    pay_unpaid: 'لم يُدفع بعد', pay_partially_paid: 'مدفوع جزئياً', pay_paid: 'مدفوع', pay_partially_refunded: 'مسترد جزئياً', pay_refunded: 'مسترد',
    live: 'تحديث مباشر', send: 'إرسال', comment: 'تعليق (اختياري)', notFound: 'لم نجد هذا المطعم.', menuEmpty: 'القائمة قيد التحضير — يرجى العودة قريبًا.', noResults: 'لا توجد أطباق مطابقة لبحثك.', unavailable: 'هذا المطعم غير متاح مؤقتاً.', offers: 'عروض اليوم', from: 'ابتداءً من', visit: 'زورونا', browseMenu: 'تصفح القائمة', call: 'اتصل', addedToCart: 'تمت الإضافة إلى طلبك', viewOrder: 'عرض الطلب', guestRating: 'تقييم الضيوف', ourMenu: 'قائمتنا', dishes: 'أطباق', dish: 'طبق',
  },
} as const;

export type TKey = keyof (typeof dict)['en'];

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: TKey) => string;
  /** Pick a localized DB field ({en, ur, ar}) with English fallback. */
  pick: (v?: Partial<Record<Lang, string>> | null) => string;
  dir: 'rtl' | 'ltr';
}

const Ctx = createContext<I18nState | null>(null);

export function I18nProvider({ children, storageKey = 'lang', initial = 'en' as Lang }: { children: ReactNode; storageKey?: string; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const s = localStorage.getItem(storageKey) as Lang | null;
      return s && s in dict ? s : initial;
    } catch {
      return initial;
    }
  });
  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      try {
        localStorage.setItem(storageKey, l);
      } catch {
        /* private mode */
      }
    },
    [storageKey],
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL[lang] ? 'rtl' : 'ltr';
    return () => {
      document.documentElement.dir = 'ltr';
      document.documentElement.lang = 'en';
    };
  }, [lang]);
  const value = useMemo<I18nState>(
    () => ({
      lang,
      setLang,
      dir: RTL[lang] ? 'rtl' : 'ltr',
      t: (k) => dict[lang][k] ?? dict.en[k] ?? k,
      pick: (v) => (v?.[lang] && v[lang]!.trim()) || v?.en || '',
    }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside provider');
  return c;
}
