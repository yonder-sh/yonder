#!/usr/bin/env python3
"""Build seed/data/geocode-hints.json from the exported cities/places/itinerary JSON.

Coordinates are best-effort hand geocodes (model knowledge, a few checked by web search
for street addresses). They are pins for maps and distance estimates, NOT verified
survey points. Re-run after re-exporting the sheet; it fails loudly if a new
country/city/area/place has no hint yet.

Usage: python3 seed/scripts/build-geocode-hints.py [seed/data]
"""
import json, os, sys, datetime

DATA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'data')

TZ = {'Japan': 'Asia/Tokyo', 'South Korea': 'Asia/Seoul', 'Vietnam': 'Asia/Ho_Chi_Minh', 'Taiwan': 'Asia/Taipei'}
ISO = {'Japan': 'JP', 'South Korea': 'KR', 'Vietnam': 'VN', 'Taiwan': 'TW'}
UTC_OFFSET = {'Japan': '+09:00', 'South Korea': '+09:00', 'Vietnam': '+07:00', 'Taiwan': '+08:00'}

# confidence: high = pin is on/within ~300 m of the thing (well-known landmark or station);
# medium = right neighborhood/block, within ~1 km (store addresses, spread-out sights);
# low = rough area only (region, TBD lodging).
COUNTRIES = {  # rough geographic center; only useful for zoom-to-country
    'Japan': (36.2048, 138.2529, 'low', 'Geographic center; zoom-to-country only'),
    'South Korea': (35.9078, 127.7669, 'low', 'Geographic center; zoom-to-country only'),
    'Vietnam': (14.0583, 108.2772, 'low', 'Geographic center; zoom-to-country only'),
    'Taiwan': (23.6978, 120.9605, 'low', 'Geographic center; zoom-to-country only'),
}

CITIES = {
    ('Japan', 'Tokyo'): (35.6812, 139.7671, 'high', 'Tokyo Station'),
    ('Japan', 'Mt. Fuji'): (35.4983, 138.7689, 'medium', 'Region, not a city: pinned at Kawaguchiko Station (Fuji Five Lakes base). Summit is 35.3606, 138.7274'),
    ('Japan', 'Nagoya'): (35.1709, 136.8815, 'high', 'Nagoya Station'),
    ('Japan', 'Kyoto'): (35.0116, 135.7681, 'high', 'Central Kyoto (Shijo/Kawaramachi); Kyoto Station is 34.9858, 135.7588'),
    ('Japan', 'Uji'): (34.8895, 135.8003, 'high', 'JR Uji Station'),
    ('Japan', 'Nara'): (34.6844, 135.8279, 'high', 'Kintetsu Nara Station (edge of Nara Park)'),
    ('Japan', 'Osaka'): (34.6937, 135.5023, 'high', 'Central Osaka'),
    ('Japan', 'Hiroshima'): (34.3853, 132.4553, 'high', 'Central Hiroshima'),
    ('Japan', 'Miyajima Island'): (34.2960, 132.3198, 'high', 'Itsukushima Shrine / floating torii'),
    ('Japan', 'Sapporo'): (43.0618, 141.3545, 'high', 'Central Sapporo (Odori)'),
    ('Japan', 'Tashirojima'): (38.2944, 141.4256, 'medium', 'Cat island off Ishinomaki, Miyagi'),
    ('Japan', 'Urayasu'): (35.6531, 139.9019, 'high', 'Urayasu city (Chiba); Tokyo Disney Resort is in its Maihama district'),
    ('Japan', 'Miyazu'): (35.5357, 135.1953, 'high', 'Miyazu city (Kyoto Pref.), gateway to Amanohashidate'),
    ('Japan', 'Ikoma'): (34.6921, 135.7006, 'high', 'Ikoma city (Nara Pref.); Mt. Ikoma summit is ~34.678, 135.678'),
    ('Japan', 'Minoh'): (34.8269, 135.4705, 'high', 'Minoh city (Osaka Pref.)'),
    ('Japan', 'Ikeda'): (34.8217, 135.4286, 'high', 'Ikeda city (Osaka Pref.)'),
    ('South Korea', 'Seoul'): (37.5665, 126.9780, 'high', 'Seoul City Hall'),
    ('South Korea', 'Suwon'): (37.2636, 127.0286, 'high', 'Central Suwon'),
    ('South Korea', 'Busan'): (35.1796, 129.0756, 'high', 'Central Busan (Seomyeon area)'),
    ('Vietnam', 'Ho Chi Minh City'): (10.7769, 106.7009, 'high', 'District 1'),
    ('Vietnam', 'Da Nang'): (16.0544, 108.2022, 'high', 'Central Da Nang'),
    ('Vietnam', 'Hoi An'): (15.8801, 108.3380, 'high', 'Hoi An town'),
    ('Vietnam', 'Hanoi'): (21.0285, 105.8542, 'high', 'Hoan Kiem Lake'),
    ('Vietnam', 'Sa Pa'): (22.3364, 103.8438, 'high', 'Sa Pa town'),
    ('Vietnam', 'Ninh Binh'): (20.2506, 105.9745, 'high', 'Ninh Binh city; Tam Coc/Trang An are ~5-8 km SW'),
    ('Vietnam', 'Hue'): (16.4637, 107.5909, 'high', 'Central Hue (Citadel is just north)'),
    ('Vietnam', 'Ha Long Bay'): (20.9101, 107.1839, 'medium', 'Bay, not a city: pinned near Ha Long city / Bai Chay'),
    ('Vietnam', 'Cat Ba'): (20.7279, 107.0480, 'high', 'Cat Ba town'),
    ('Taiwan', 'Taipei'): (25.0375, 121.5637, 'high', 'Taipei City Hall (Xinyi); Taipei Main Station is 25.0478, 121.5170'),
    ('Taiwan', 'Shifen'): (25.0487, 121.7757, 'high', 'Shifen Old Street / station; Shifen Waterfall is ~1.5 km E'),
    ('Taiwan', 'Jiufen'): (25.1092, 121.8445, 'high', 'Jiufen Old Street'),
}

AREAS = {
    ('Japan', 'Tokyo', 'Shinjuku'): (35.6896, 139.7006, 'high', 'Shinjuku Station'),
    ('Japan', 'Tokyo', 'Shibuya'): (35.6595, 139.7005, 'high', 'Shibuya Station / scramble crossing'),
    ('Japan', 'Tokyo', 'Harajuku'): (35.6702, 139.7027, 'high', 'Harajuku Station'),
    ('Japan', 'Tokyo', 'Omotesando'): (35.6654, 139.7121, 'high', 'Omotesando Station'),
    ('Japan', 'Tokyo', 'Minami-Aoyama'): (35.6640, 139.7170, 'medium', 'Minami-Aoyama (just SE of Omotesando)'),
    ('Japan', 'Tokyo', 'Asakusa'): (35.7118, 139.7966, 'high', 'Asakusa Station'),
    ('Japan', 'Tokyo', 'Akihabara'): (35.6984, 139.7731, 'high', 'Akihabara Station'),
    ('Japan', 'Tokyo', 'Azabu-Juban'): (35.6544, 139.7372, 'high', 'Azabu-Juban Station'),
    ('Japan', 'Tokyo', 'Ginza'): (35.6717, 139.7650, 'high', 'Ginza 4-chome crossing'),
    ('Japan', 'Tokyo', 'Nihonbashi'): (35.6841, 139.7744, 'high', 'Nihonbashi bridge / station'),
    ('Japan', 'Tokyo', 'Toyosu'): (35.6550, 139.7964, 'high', 'Toyosu Station'),
    ('Japan', 'Tokyo', 'Mitaka'): (35.6962, 139.5704, 'medium', 'Mitaka city (western Tokyo); pinned at Inokashira Park / Ghibli Museum'),
    ('Japan', 'Tokyo', 'Haneda'): (35.5494, 139.7798, 'high', 'Haneda Airport (HND)'),
    ('Japan', 'Tokyo', 'Setagaya'): (35.6464, 139.6533, 'high', 'Setagaya ward office area'),
    ('Japan', 'Tokyo', 'Nakano'): (35.7058, 139.6658, 'high', 'Nakano Station'),
    ('Japan', 'Kyoto', 'Arashiyama'): (35.0094, 135.6668, 'high', 'Togetsukyo Bridge'),
    ('Japan', 'Kyoto', 'Fushimi'): (34.9671, 135.7727, 'medium', 'Fushimi ward is large; pinned at Fushimi Inari (the only thing listed there)'),
    ('Japan', 'Kyoto', 'Higashiyama'): (34.9964, 135.7785, 'high', 'Higashiyama (Gion-Kiyomizu side of Kyoto)'),
    ('Japan', 'Kyoto', 'Kawaramachi'): (35.0036, 135.7693, 'high', 'Shijo-Kawaramachi crossing'),
    ('Japan', 'Kyoto', 'Kinugasa'): (35.0365, 135.7250, 'medium', 'Kinugasa area between Kinkaku-ji and Ryoan-ji'),
    ('Japan', 'Mt. Fuji', 'Kawaguchiko'): (35.4983, 138.7689, 'high', 'Kawaguchiko Station'),
    ('Japan', 'Mt. Fuji', 'Fujiyoshida'): (35.4875, 138.8077, 'high', 'Fujiyoshida city'),
    ('Japan', 'Mt. Fuji', 'Fujinomiya'): (35.2222, 138.6214, 'high', 'Fujinomiya city; Shiraito Falls is ~10 km N'),
    ('Japan', 'Nagoya', 'Nagakute'): (35.1838, 137.0484, 'high', 'Nagakute city (Aichi); Ghibli Park is on its east side'),
    ('Japan', 'Nagoya', 'Nagoya Station'): (35.1709, 136.8815, 'high', 'Nagoya Station'),
    ('Japan', 'Osaka', 'Bay Area'): (34.6654, 135.4323, 'medium', 'Osaka Bay Area (Universal City)'),
    ('Japan', 'Osaka', 'Namba'): (34.6660, 135.5010, 'high', 'Namba Station'),
    ('Japan', 'Osaka', 'Nipponbashi'): (34.6594, 135.5063, 'high', 'Nipponbashi / Den Den Town'),
    ('Japan', 'Osaka', 'Shinsaibashi'): (34.6750, 135.5010, 'high', 'Shinsaibashi Station'),
    ('Japan', 'Osaka', 'Shinsekai'): (34.6523, 135.5063, 'high', 'Shinsekai'),
    ('Japan', 'Osaka', 'Tennoji'): (34.6465, 135.5133, 'high', 'Tennoji Station'),
    ('Japan', 'Osaka', 'Umeda'): (34.7025, 135.4959, 'high', 'Osaka/Umeda Station'),
    ('Japan', 'Urayasu', 'Maihama'): (35.6340, 139.8836, 'high', 'Maihama Station (Tokyo Disney Resort)'),
    ('South Korea', 'Seoul', 'Gangnam'): (37.5116, 127.0595, 'medium', 'Gangnam-gu is large; pinned at COEX (Samseong), where the listed place is'),
    ('Taiwan', 'Taipei', "Da'an District"): (25.0263, 121.5436, 'high', "Da'an District"),
    ('Vietnam', 'Hanoi', 'Old Quarter'): (21.0340, 105.8500, 'high', 'Hanoi Old Quarter'),
    ('Vietnam', 'Hoi An', 'Old Town'): (15.8770, 108.3280, 'high', 'Hoi An Ancient Town'),
}

# key = (Country, City, Area or '', Place)
PLACES = {
    ('Japan', 'Tokyo', '', 'Shinjuku'): (35.6896, 139.7006, 'high', 'Shinjuku Station'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Yodobashi Camera'): (35.6913, 139.6975, 'high', 'Yodobashi Shinjuku West main store'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Bic Camera'): (35.6926, 139.6989, 'medium', 'Bic Camera Shinjuku West Exit store (there are several Shinjuku branches)'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Camera Town'): (35.6917, 139.6968, 'medium', 'Nishi-Shinjuku 1-chome camera cluster (Map Camera etc.)'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Cha no Ikedaya'): (35.6905, 139.6990, 'medium', 'Odakyu Ace underground mall, west exit'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Bar Benfiddich'): (35.6923, 139.6971, 'medium', 'Nishi-Shinjuku 1-13-7'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Omoide Yokocho'): (35.6929, 139.6995, 'high', None),
    ('Japan', 'Tokyo', 'Shinjuku', 'Golden Gai'): (35.6939, 139.7045, 'high', None),
    ('Japan', 'Tokyo', 'Shinjuku', 'Kabukicho'): (35.6950, 139.7020, 'high', 'Godzilla head / Toho building'),
    ('Japan', 'Tokyo', 'Shinjuku', 'Don Quijote'): (35.6943, 139.7027, 'medium', 'Kabukicho 24h branch'),
    ('Japan', 'Tokyo', 'Nakano', 'Nakano Broadway'): (35.7089, 139.6655, 'high', None),
    ('Japan', 'Tokyo', '', 'Shibuya'): (35.6595, 139.7005, 'high', 'Shibuya Station / crossing'),
    ('Japan', 'Tokyo', 'Shibuya', 'Shibuya crossing'): (35.6595, 139.7005, 'high', None),
    ('Japan', 'Tokyo', 'Shibuya', 'Love Hotel Hill'): (35.6575, 139.6955, 'high', 'Dogenzaka 2-chome'),
    ('Japan', 'Tokyo', 'Shibuya', 'Shibuya Sky'): (35.6585, 139.7021, 'high', 'Shibuya Scramble Square'),
    ('Japan', 'Tokyo', 'Shibuya', 'JINS'): (35.6618, 139.7003, 'medium', 'JINS Shibuya flagship (Jinnan); exact store not verified'),
    ('Japan', 'Tokyo', 'Shibuya', 'Hands Shibuya'): (35.6617, 139.6981, 'high', 'Udagawacho 12-18'),
    ('Japan', 'Tokyo', 'Shibuya', 'Shibuya Loft'): (35.6611, 139.6989, 'high', 'Udagawacho 21-1'),
    ('Japan', 'Tokyo', 'Harajuku', 'Takeshita Street'): (35.6716, 139.7050, 'high', None),
    ('Japan', 'Tokyo', 'Harajuku', 'Samoyed Cafe Moffu'): (35.6711, 139.7062, 'medium', 'Harajuku store, Jingumae 3-21-21 B1 (web-checked address); a Takeshita Street branch also exists'),
    ('Japan', 'Tokyo', 'Harajuku', 'Meiji Jingu'): (35.6764, 139.6993, 'high', 'Main shrine hall'),
    ('Japan', 'Tokyo', 'Minami-Aoyama', 'Imabari Towel (Minami-Aoyama)'): (35.6645, 139.7150, 'medium', 'Minami-Aoyama 5-chome; exact store not verified'),
    ('Japan', 'Tokyo', 'Omotesando', 'glänta (Omotesando)'): (35.6682, 139.7098, 'medium', 'Jingumae 4-8-2 (web-checked address)'),
    ('Japan', 'Tokyo', 'Omotesando', 'Onitsuka Tiger (Omotesando)'): (35.6687, 139.7063, 'medium', 'Omotesando flagship'),
    ('Japan', 'Tokyo', 'Omotesando', 'PORTER Omotesando'): (35.6655, 139.7090, 'medium', 'Jingumae 5-chome backstreet'),
    ('Japan', 'Tokyo', '', 'Asakusa'): (35.7118, 139.7966, 'high', 'Asakusa Station'),
    ('Japan', 'Tokyo', 'Asakusa', 'Senso-ji Temple'): (35.7148, 139.7967, 'high', 'Main hall'),
    ('Japan', 'Tokyo', 'Asakusa', 'Kappabashi Street'): (35.7132, 139.7887, 'high', 'Kappabashi-dogugai, midpoint'),
    ('Japan', 'Tokyo', '', 'Akihabara'): (35.6984, 139.7731, 'high', 'Akihabara Station'),
    ('Japan', 'Tokyo', 'Azabu-Juban', 'Bar Centifolia'): (35.6561, 139.7361, 'medium', 'Azabu-Juban 1-6-5, 6F (web-checked address)'),
    ('Japan', 'Tokyo', 'Ginza', 'Ginza Tsutaya Books'): (35.6696, 139.7640, 'high', 'Ginza Six 6F'),
    ('Japan', 'Tokyo', 'Ginza', 'Uniqlo Ginza'): (35.6703, 139.7644, 'high', 'Ginza 6-9-5'),
    ('Japan', 'Tokyo', 'Ginza', 'GU Ginza'): (35.6712, 139.7641, 'medium', 'Ginza 5-chome, near Uniqlo Ginza'),
    ('Japan', 'Tokyo', 'Ginza', 'Itoya (G.Itoya)'): (35.6739, 139.7676, 'high', 'Ginza 2-7-15'),
    ('Japan', 'Tokyo', 'Ginza', 'MUJI Ginza'): (35.6741, 139.7671, 'medium', 'Ginza 3-3-5 (Namiki-dori)'),
    ('Japan', 'Tokyo', 'Nihonbashi', 'Nihonbashi Nishikawa'): (35.6829, 139.7735, 'medium', 'COREDO Nihonbashi area; branch reportedly closing ~Oct 2026 for redevelopment'),
    ('Japan', 'Tokyo', 'Toyosu', 'teamLab Planets'): (35.6491, 139.7897, 'high', 'Shin-Toyosu'),
    ('Japan', 'Tokyo', 'Mitaka', 'Ghibli Museum'): (35.6962, 139.5704, 'high', None),
    ('Japan', 'Tokyo', 'Haneda', 'JAL Sky Museum'): (35.5563, 139.7546, 'medium', 'JAL M1 hangar by Shin-Seibijo monorail station'),
    ('Japan', 'Tokyo', 'Setagaya', 'Gotokuji Temple'): (35.6488, 139.6474, 'high', None),
    ('Japan', 'Tokyo', 'Haneda', 'Anamori Inari Shrine'): (35.5500, 139.7461, 'high', 'By Anamori-inari Station (Keikyu)'),
    ('Japan', 'Urayasu', 'Maihama', 'Tokyo DisneySea'): (35.6267, 139.8851, 'high', None),
    ('Japan', 'Mt. Fuji', 'Fujinomiya', 'Shiraito Falls'): (35.3125, 138.5874, 'high', None),
    ('Japan', 'Mt. Fuji', 'Kawaguchiko', 'Lake Kawaguchiko'): (35.5140, 138.7550, 'high', 'Lake center; spans ~6 km E-W'),
    ('Japan', 'Mt. Fuji', 'Kawaguchiko', 'Oishi Park'): (35.5237, 138.7420, 'high', 'North shore'),
    ('Japan', 'Mt. Fuji', 'Kawaguchiko', 'Mt. Fuji Panoramic Ropeway'): (35.5006, 138.7717, 'high', 'Lower station (east shore)'),
    ('Japan', 'Mt. Fuji', 'Fujiyoshida', 'Chureito Pagoda'): (35.5012, 138.8017, 'high', 'Arakurayama Sengen Park'),
    ('Japan', 'Nagoya', 'Nagakute', 'Ghibli Park'): (35.1739, 137.0877, 'high', 'Aichi Expo Memorial Park (Moricoro Park)'),
    ('Japan', 'Nagoya', 'Nagoya Station', 'TSUTAYA BOOKSTORE (Noritake Shinmachi)'): (35.1790, 136.8800, 'medium', 'Aeon Mall Nagoya Noritake Garden, ~1 km N of Nagoya Station'),
    ('Japan', 'Kyoto', 'Higashiyama', 'Gion'): (35.0037, 135.7751, 'high', 'Hanamikoji / Gion Shijo'),
    ('Japan', 'Kyoto', 'Fushimi', 'Fushimi Inari Shrine'): (34.9671, 135.7727, 'high', 'Main gate'),
    ('Japan', 'Kyoto', 'Kinugasa', 'Kinkaku-ji'): (35.0394, 135.7292, 'high', None),
    ('Japan', 'Kyoto', 'Kinugasa', 'Ryoan-ji Temple'): (35.0345, 135.7182, 'high', None),
    ('Japan', 'Kyoto', 'Arashiyama', 'Arashiyama Bamboo Grove'): (35.0170, 135.6717, 'high', None),
    ('Japan', 'Kyoto', 'Arashiyama', 'Miffy Sakura Kitchen'): (35.0155, 135.6770, 'medium', 'Near Arashiyama Station (Randen)'),
    ('Japan', 'Kyoto', 'Higashiyama', 'Kiyomizu-dera Temple'): (34.9949, 135.7850, 'high', None),
    ('Japan', 'Kyoto', '', 'Nijo Castle'): (35.0142, 135.7481, 'high', None),
    ('Japan', 'Kyoto', 'Kawaramachi', 'Nishiki Market'): (35.0050, 135.7649, 'high', None),
    ('Japan', 'Kyoto', 'Kawaramachi', 'Pontocho'): (35.0048, 135.7709, 'high', None),
    ('Japan', 'Kyoto', 'Higashiyama', 'Sanjusangen-do'): (34.9879, 135.7717, 'high', None),
    ('Japan', 'Kyoto', 'Higashiyama', "Philosopher's Path"): (35.0205, 135.7945, 'high', 'Midpoint; path runs ~2 km N-S (Ginkaku-ji to Nanzen-ji)'),
    ('Japan', 'Kyoto', 'Arashiyama', 'Otagi Nenbutsu-ji'): (35.0284, 135.6614, 'high', 'Okusaga, ~2.5 km NW of the bamboo grove'),
    ('Japan', 'Uji', '', 'Byodoin Omotesando (tea shop street)'): (34.8905, 135.8055, 'medium', 'Street leading to Byodo-in'),
    ('Japan', 'Miyazu', '', 'Amanohashidate'): (35.5697, 135.1914, 'high', 'Sandbar midpoint'),
    ('Japan', 'Nara', '', 'Nara Park'): (34.6851, 135.8430, 'high', None),
    ('Japan', 'Nara', '', 'Todai-ji'): (34.6890, 135.8398, 'high', 'Daibutsuden'),
    ('Japan', 'Nara', '', 'Kasuga Taisha'): (34.6813, 135.8484, 'high', None),
    ('Japan', 'Nara', '', 'Nakatanidou'): (34.6818, 135.8297, 'medium', 'Sanjo-dori / Higashimuki corner'),
    ('Japan', 'Osaka', 'Namba', 'Dotonbori'): (34.6687, 135.5013, 'high', 'Glico sign / Ebisu Bridge'),
    ('Japan', 'Osaka', '', 'Osaka Castle'): (34.6873, 135.5262, 'high', 'Main keep'),
    ('Japan', 'Osaka', 'Bay Area', 'Universal Studios'): (34.6654, 135.4323, 'high', 'Universal Studios Japan'),
    ('Japan', 'Osaka', 'Nipponbashi', 'Den Den Town'): (34.6594, 135.5063, 'high', None),
    ('Japan', 'Osaka', 'Nipponbashi', 'Kuromon Market'): (34.6653, 135.5066, 'high', None),
    ('Japan', 'Osaka', 'Shinsaibashi', 'Shinsaibashi-suji'): (34.6725, 135.5013, 'high', 'Arcade midpoint'),
    ('Japan', 'Osaka', 'Umeda', 'Umeda Sky Building'): (34.7053, 135.4906, 'high', None),
    ('Japan', 'Osaka', 'Shinsekai', 'Tsutenkaku Tower'): (34.6525, 135.5063, 'high', None),
    ('Japan', 'Osaka', 'Tennoji', 'Harukas 300'): (34.6459, 135.5135, 'high', 'Abeno Harukas'),
    ('Japan', 'Osaka', 'Namba', 'Namba Yasaka Shrine'): (34.6614, 135.4974, 'high', None),
    ('Japan', 'Osaka', 'Namba', 'Hozenji Yokocho'): (34.6680, 135.5024, 'high', None),
    ('Japan', 'Ikoma', '', 'Ikoma Sanjo Amusement Park'): (34.6776, 135.6781, 'medium', 'Mt. Ikoma summit'),
    ('Japan', 'Minoh', '', 'Katsuoji Temple'): (34.8651, 135.4905, 'medium', None),
    ('Japan', 'Ikeda', '', 'Cup Noodles Museum Osaka Ikeda'): (34.8183, 135.4269, 'medium', 'Near Hankyu Ikeda Station'),
    ('South Korea', 'Seoul', '', 'Seongsu'): (37.5445, 127.0557, 'high', 'Seongsu Station'),
    ('South Korea', 'Seoul', '', 'Hannam'): (37.5345, 127.0026, 'high', 'Hannam-dong'),
    ('South Korea', 'Seoul', '', 'Itaewon'): (37.5345, 126.9946, 'high', 'Itaewon Station'),
    ('South Korea', 'Seoul', 'Gangnam', 'Starfield Library (COEX)'): (37.5100, 127.0600, 'high', 'COEX Mall'),
    ('South Korea', 'Suwon', '', 'Starfield Library (Suwon)'): (37.2877, 126.9907, 'medium', 'Starfield Suwon, 175 Suseong-ro, Jangan-gu (web-checked address)'),
    ('South Korea', 'Suwon', '', 'Hwaseong Fortress'): (37.2871, 127.0118, 'high', 'Fortress loop (~5.7 km); pinned near Hwaseomun/Janganmun side'),
    ('South Korea', 'Busan', '', 'Gamcheon Culture Village'): (35.0975, 129.0106, 'high', None),
    ('South Korea', 'Busan', '', 'Haedong Yonggungsa Temple'): (35.1884, 129.2233, 'high', None),
    ('South Korea', 'Busan', '', 'Oryukdo Skywalk'): (35.1004, 129.1244, 'high', None),
    ('South Korea', 'Busan', '', 'Haeundae Blueline Park'): (35.1587, 129.1723, 'medium', 'Mipo station end; line runs ~4.8 km to Songjeong'),
    ('South Korea', 'Busan', '', 'Seokbulsa Temple'): (35.2355, 129.0613, 'medium', 'Geumjeongsan'),
    ('South Korea', 'Busan', '', 'Gwangalli Beach'): (35.1532, 129.1187, 'high', None),
    ('South Korea', 'Busan', '', 'Dongbaekseom Island Coastal Promenade'): (35.1535, 129.1522, 'high', None),
    ('South Korea', 'Busan', '', 'Haewol Observatory'): (35.1578, 129.1810, 'medium', 'Jung-dong, Haeundae-gu; ~1.1 km along the coastal path E of Mipo (web-checked)'),
    ('Vietnam', 'Ho Chi Minh City', '', 'Ben Thanh Market'): (10.7725, 106.6980, 'high', None),
    ('Vietnam', 'Ho Chi Minh City', '', 'Cu Chi Tunnels'): (11.1422, 106.4627, 'medium', 'Ben Dinh site (Ben Duoc is ~15 km further)'),
    ('Vietnam', 'Ho Chi Minh City', '', 'Bui Vien Walking Street'): (10.7672, 106.6933, 'high', None),
    ('Vietnam', 'Ho Chi Minh City', '', 'Saigon Central Post Office'): (10.7799, 106.6999, 'high', None),
    ('Vietnam', 'Da Nang', '', 'Ba Na Hills'): (15.9977, 107.9880, 'high', 'Summit resort'),
    ('Vietnam', 'Da Nang', '', 'Golden Bridge'): (15.9950, 107.9965, 'high', 'Inside Ba Na Hills'),
    ('Vietnam', 'Da Nang', '', 'Monkey Mountain'): (16.1190, 108.2800, 'medium', 'Son Tra Peninsula, central'),
    ('Vietnam', 'Da Nang', '', 'Marble Mountain'): (16.0040, 108.2630, 'high', None),
    ('Vietnam', 'Da Nang', '', 'My Son Sanctuary'): (15.7640, 108.1240, 'high', 'Actually in Quang Nam, ~40 km SW of Hoi An'),
    ('Vietnam', 'Da Nang', '', 'Lady Buddha'): (16.1003, 108.2778, 'high', 'Linh Ung Pagoda, Son Tra'),
    ('Vietnam', 'Da Nang', '', 'Dragon Bridge'): (16.0612, 108.2272, 'high', None),
    ('Vietnam', 'Da Nang', '', 'My Khe'): (16.0544, 108.2477, 'high', None),
    ('Vietnam', 'Hoi An', '', 'Old Town'): (15.8770, 108.3280, 'high', None),
    ('Vietnam', 'Hoi An', 'Old Town', 'Fujian Assembly Hall'): (15.8778, 108.3302, 'high', None),
    ('Vietnam', 'Hoi An', 'Old Town', 'Quan Cong Temple'): (15.8773, 108.3310, 'high', None),
    ('Vietnam', 'Hoi An', 'Old Town', 'Japanese Covered Bridge'): (15.8771, 108.3262, 'high', None),
    ('Vietnam', 'Hanoi', '', 'Old Quarter'): (21.0340, 105.8500, 'high', None),
    ('Vietnam', 'Hanoi', '', 'Train street'): (21.0286, 105.8436, 'medium', 'Tran Phu / Le Duan section; there are a few stretches'),
    ('Vietnam', 'Hanoi', 'Old Quarter', 'Beer street'): (21.0358, 105.8522, 'high', 'Ta Hien'),
    ('Vietnam', 'Ninh Binh', '', 'Mua Caves'): (20.2370, 105.9360, 'high', None),
    ('Vietnam', 'Ninh Binh', '', 'Trang An'): (20.2560, 105.8950, 'high', 'Boat wharf'),
    ('Vietnam', 'Ninh Binh', '', 'Tam Coc'): (20.2170, 105.9160, 'high', 'Boat wharf'),
    ('Taiwan', 'Taipei', '', "Da'an District"): (25.0263, 121.5436, 'high', None),
    ('Taiwan', 'Taipei', "Da'an District", 'Daan Forest Park'): (25.0298, 121.5358, 'high', None),
    ('Taiwan', 'Taipei', '', 'National Palace Museum'): (25.1024, 121.5485, 'high', None),
    ('Taiwan', 'Taipei', '', 'Wang Tea'): (25.0572, 121.5139, 'medium', 'Lane 64, Sec. 2 Chongqing N. Rd, Datong (Dadaocheng) (web-checked address)'),
    ('Taiwan', 'Jiufen', '', 'Jiufen Old Street'): (25.1098, 121.8440, 'high', None),
    ('Taiwan', 'Jiufen', '', 'Jiufen Teahouse'): (25.1092, 121.8448, 'medium', None),
    ('Taiwan', 'Jiufen', '', 'Teapot Mountain'): (25.1030, 121.8680, 'medium', 'Summit; trailhead near Jinguashi'),
}

# Itinerary rows whose Place is not a Places row (travel legs, lodging, meals with a city Area)
TRANSIT = {
    'Shinjuku Station': (35.6896, 139.7006, 'high'),
    'Kawaguchiko Station': (35.4983, 138.7689, 'high'),
    'Shiraito Falls': (35.3125, 138.5874, 'high'),
    'Shin-Fuji Station': (35.1424, 138.6634, 'high'),
    'Nagoya Station': (35.1709, 136.8815, 'high'),
}
ITIN_ALIASES = [
    {'itinerary_place': 'Chureito Pagoda (sunrise)', 'maps_to': 'Japan|Mt. Fuji|Fujiyoshida|Chureito Pagoda'},
    {'itinerary_place': 'Fuji Excursion (Shinjuku → Kawaguchiko)', 'route': ['Shinjuku Station', 'Kawaguchiko Station']},
    {'itinerary_place': 'Bus → Shiraito Falls', 'route': ['Kawaguchiko Station', 'Shiraito Falls']},
    {'itinerary_place': 'Shiraito → Shin-Fuji → Nagoya', 'route': ['Shiraito Falls', 'Shin-Fuji Station', 'Nagoya Station']},
    {'itinerary_place': 'Drop bags at ryokan', 'maps_to': 'Japan|Mt. Fuji|Kawaguchiko', 'note': 'Ryokan not booked yet; use the Kawaguchiko area pin (low confidence)'},
    {'itinerary_place': 'Ryokan check-in + onsen', 'maps_to': 'Japan|Mt. Fuji|Kawaguchiko', 'note': 'Ryokan not booked yet'},
    {'itinerary_place': 'Dinner (ryokan kaiseki)', 'maps_to': 'Japan|Mt. Fuji|Kawaguchiko', 'note': 'At the ryokan'},
    {'itinerary_place': 'Breakfast (ryokan)', 'maps_to': 'Japan|Mt. Fuji|Kawaguchiko', 'note': 'At the ryokan'},
]
# Itinerary Area values that are not Places areas
ITIN_AREAS = {
    ('Japan', 'Mt. Fuji', 'Shinjuku'): ('Japan', 'Tokyo', 'Shinjuku'),   # Day 5 departs from Shinjuku
    ('Japan', 'Mt. Fuji', 'Nagoya'): ('Japan', 'Nagoya', 'Nagoya Station'),  # Day 6 (Mt. Fuji → Nagoya) dinner, Area "Nagoya"
}


def k(*parts):
    return '|'.join(parts)


def pt(v, country):
    lat, lng, conf, note = v
    o = {'lat': lat, 'lng': lng, 'timezone': TZ[country], 'utc_offset': UTC_OFFSET[country], 'confidence': conf}
    if note:
        o['note'] = note
    return o


def main():
    places = json.load(open(os.path.join(DATA, 'places.json')))['rows']
    cities = json.load(open(os.path.join(DATA, 'cities.json')))['rows']
    itin = json.load(open(os.path.join(DATA, 'itinerary.json')))['rows']
    missing = []

    countries = sorted({r['Country'] for r in places} | {r['Country'] for r in cities})
    out_c = []
    for c in countries:
        if c not in COUNTRIES:
            missing.append(('country', c)); continue
        out_c.append({'key': c, 'country': c, 'iso2': ISO[c], **pt(COUNTRIES[c], c)})

    city_src = {}
    for r in cities:
        city_src.setdefault((r['Country'], r['City']), {'in_cities_tab': False, 'cities_row': None, 'status': None, 'places_count': 0})
        city_src[(r['Country'], r['City'])].update(in_cities_tab=True, cities_row=r['_row'], status=r['Status'])
    for r in places:
        city_src.setdefault((r['Country'], r['City']), {'in_cities_tab': False, 'cities_row': None, 'status': None, 'places_count': 0})
        city_src[(r['Country'], r['City'])]['places_count'] += 1
    out_city = []
    for (co, ci), src in sorted(city_src.items()):
        if (co, ci) not in CITIES:
            missing.append(('city', co, ci)); continue
        out_city.append({'key': k(co, ci), 'country': co, 'city': ci, **src, **pt(CITIES[(co, ci)], co)})

    area_src = {}
    for r in places:
        if r['Area']:
            area_src.setdefault((r['Country'], r['City'], r['Area']), set()).add('places')
    for r in itin:
        a = r['Area']
        if not a:
            continue
        city = (r['_day'] or {}).get('city') or 'Tokyo'
        if city.startswith('Mt. Fuji'):
            city = 'Mt. Fuji'
        key = ('Japan', city, a)
        key = ITIN_AREAS.get(key, key)
        if key not in AREAS and ('Japan', 'Mt. Fuji', a) in AREAS:
            key = ('Japan', 'Mt. Fuji', a)
        area_src.setdefault(key, set()).add('itinerary')
    out_area = []
    for (co, ci, a), src in sorted(area_src.items()):
        if (co, ci, a) not in AREAS:
            missing.append(('area', co, ci, a)); continue
        out_area.append({'key': k(co, ci, a), 'country': co, 'city': ci, 'area': a, 'seen_in': sorted(src), **pt(AREAS[(co, ci, a)], co)})

    out_p = []
    seen = set()
    for r in places:
        key = (r['Country'], r['City'], r['Area'] or '', r['Place'])
        if key not in PLACES:
            missing.append(('place', *key)); continue
        seen.add(key)
        o = {'key': k(*key), 'country': key[0], 'city': key[1], 'area': r['Area'], 'place': r['Place'], 'places_row': r['_row'],
             'category': r['Category'], 'is_area_row': (r['Category'] == 'Neighborhood' and not r['Area']), **pt(PLACES[key], key[0])}
        out_p.append(o)
    stale = [k(*x) for x in PLACES if x not in seen]

    place_names = {r['Place'] for r in places}
    itin_unmatched = sorted({r['Place'] for r in itin if r['Place'] not in place_names and r['Category'] not in ('Meal',)})
    alias_names = {a['itinerary_place'] for a in ITIN_ALIASES}
    for n in itin_unmatched:
        if n not in alias_names:
            missing.append(('itinerary place', n))

    if missing:
        print('MISSING geocode hints:', *missing, sep='\n  ')
        sys.exit(1)

    doc = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        'about': 'Best-effort WGS84 pins + IANA timezones for every distinct country / city / area / place in the Asia 2027 sheet. '
                 'Hand-geocoded from model knowledge; street-address places marked "(web-checked address)" were looked up by address. '
                 'Not survey-grade: verify medium/low pins before showing walking directions.',
        'key_format': 'Country|City|Area|Place (Area is empty for places with no Area, e.g. "Japan|Kyoto||Nijo Castle"). Matches places.json rows by (Country, City, Area, Place).',
        'confidence_scale': {'high': 'on the thing or within ~300 m (landmark, station, well-known store)',
                             'medium': 'right block/neighborhood, within ~1 km (address-level guess, big or spread-out sight, one of several branches)',
                             'low': 'rough region only'},
        'timezones': {c: {'iana': TZ[c], 'utc_offset': UTC_OFFSET[c], 'dst': False} for c in countries},
        'timezone_note': 'None of the four countries observe DST. Vietnam uses Asia/Ho_Chi_Minh for the whole country (Asia/Saigon is a deprecated alias). '
                         'The spreadsheet itself is in America/New_York, and Action Timeline "Time (ET)" values are Eastern Time.',
        'countries': out_c,
        'cities': out_city,
        'areas': out_area,
        'places': out_p,
        'transit_points': [{'name': n, 'lat': v[0], 'lng': v[1], 'timezone': 'Asia/Tokyo', 'confidence': v[2]} for n, v in TRANSIT.items()],
        'itinerary_aliases': ITIN_ALIASES,
        'itinerary_area_aliases': [{'itinerary': k(*a), 'maps_to': k(*b)} for a, b in ITIN_AREAS.items()],
    }
    if stale:
        doc['stale_hints_not_in_sheet'] = stale
    fn = os.path.join(DATA, 'geocode-hints.json')
    json.dump(doc, open(fn, 'w'), ensure_ascii=False, indent=2)
    from collections import Counter
    print(f"wrote {fn}: {len(out_c)} countries, {len(out_city)} cities, {len(out_area)} areas, {len(out_p)} places; "
          f"confidence {dict(Counter(p['confidence'] for p in out_p))}; stale={stale}")


if __name__ == '__main__':
    main()
