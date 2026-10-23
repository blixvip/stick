# Language completion review

All **26 supported non-English language packs** cover the current **6,718 message keys and 44 plural messages**, including every required CLDR form. English remains the authoritative source. Each translator had exclusive ownership of one pack at a time; a different reviewer inspected the original UI and diagnostic context for every completed pack. Integration independently reviewed additions authored during review, including the six final desktop-update explanations in every language. Authors ran the read-only strict validator; integration alone changed shared code, generated outputs, tests, documentation and commits.

These are **AI contextual reviews, not native-speaker certification**. Coverage measures completeness, not fluency quality. Accurate existing translations were retained and contextual mistranslations corrected. The terminology column records specialist choices that would benefit from native animation-editor review.

| Language | Locale | Coverage | Required plural categories (total forms) | Second review | Terminology to revisit |
| --- | --- | --- | --- | --- | --- |
| Arabic | ar | 6,718/6,718; zero fallback | zero, one, two, few, many, other (264) | Complete; independent contextual AI review | Skin: كسوة; Tweener: أداة التحريك البيني |
| German | de | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Bildhaltezeit, Oberflächenbindungen |
| French | fr | 6,718/6,718; zero fallback | one, many, other (132) | Complete; independent contextual AI review | Peau, Pose intermédiaire |
| Hebrew | he | 6,718/6,718; zero fallback | one, two, other (132) | Complete; independent contextual AI review | התמרה, כלי תנוחות ביניים |
| Italian | it | 6,718/6,718; zero fallback | one, other, many (132) | Complete; independent contextual AI review | Intercalazione principale, articolazioni di deformazione |
| Spanish | es | 6,718/6,718; zero fallback | one, many, other (132) | Complete; independent contextual AI review | Spain register, spatial joints and skin |
| Spanish (Latin America) | es-419 | 6,718/6,718; zero fallback | one, many, other (132) | Complete; independent contextual AI review | Regional register, deformation and pitch controls |
| Portuguese (Brazil) | pt-BR | 6,718/6,718; zero fallback | one, many, other (132) | Complete; independent contextual AI review | Alça, articulação, pele and quadro-chave |
| Dutch | nl | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Mesh, skin, rig and onion skin loanwords |
| Czech | cs | 6,718/6,718; zero fallback | one, few, many, other (176) | Complete; independent contextual AI review | Deformation, sprite and spiritual-aura terms |
| Danish | da | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Overfladebindinger, indbagning, løgskind |
| Finnish | fi | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Sipulinkuori, Haitu, Valon leviäminen |
| Norwegian Bokmål | nb | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Hudbinding, romledd, strøkrespons |
| Polish | pl | 6,718/6,718; zero fallback | one, few, many, other (176) | Complete; independent contextual AI review | Powłoka, ścieżka kątowa, utrwalanie |
| Russian | ru | 6,718/6,718; zero fallback | one, few, many, other (176) | Complete; independent contextual AI review | Стержневая фигура, Дымная струя, skin and inherited values |
| Ukrainian | uk | 6,718/6,718; zero fallback | one, few, many, other (176) | Complete; independent contextual AI review | Опорна проміжна поза, bloom and depth paths |
| Croatian | hr | 6,718/6,718; zero fallback | one, few, other (132) | Complete; independent contextual AI review | Raspršeni sjaj, pramen, skin and VFX style names |
| Slovenian | sl | 6,718/6,718; zero fallback | one, two, few, other (176) | Complete; independent contextual AI review | Ovojnica, prosojne sličice, soft knee and sprite |
| Romanian | ro | 6,718/6,718; zero fallback | one, few, other (132) | Complete; independent contextual AI review | Înveliș, origin support, wisp and sprite |
| Hungarian | hu | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Hagymahéjnézet, bőrözés, segédstruktúra and VFX specialist terms |
| Greek | el | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Στιγμιότυπο, περίβλημα, ενδιάμεση στάση |
| Turkish | tr | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Yüzey bağı, çizim hücresi, soğan zarı and specialist effects |
| Indonesian | id | 6,718/6,718; zero fallback | other (44) | Complete; independent contextual AI review | Penjajaran, kontur glif, rentang waktu tampil and specialist effects |
| Vietnamese | vi | 6,718/6,718; zero fallback | other (44) | Complete; independent contextual AI review | Linked instances, held drawing/exposure, virtual support bones, view-corrected skin and specialist VFX |
| Chinese (Simplified) | zh-Hans | 6,718/6,718; zero fallback | other (44) | Complete; independent contextual AI review | 蒙皮, 过渡姿势, 流光 and 灵气 |
| Kazakh | kk | 6,718/6,718; zero fallback | one, other (88) | Complete; independent contextual AI review | Қаптама, Өтпелі поза, Кадр іздері; keyframes, easing, sparse paste and virtual support |

Reviews cover all 447 computed VFX messages, particle timing and physics, all owned diagnostics, named and nested parameter grammar, and every required plural form. They distinguish figure definitions and instances, joints and segments, frames and keyframes, inbetweens, drawing hold duration and photographic exposure, view fitting and resizing, camera fades and speed easing, and coordinate origins and temporal beginnings. Shortcut tokens, units, placeholders, machine values, filenames and authored names/text retain their contracts. Original imported Pivot catalogs remain unchanged as provenance.

The duplicate-caption defect was in the shared binding bridge: adopting a bound child removed the retained caption-slot marker, so later translation refreshes appended another caption. The bridge now retains that node. Repeated locale changes and subtree registration keep one VFX/More caption, including the original icon and shortcut nodes. Shared components also consume existing message metadata for popover headings, command-palette search/results and tool-option selects. Their focus, drafts, selection and session cleanup are verified.

Owners connect modern controls, recovery choices, VFX presets and timelines, drawing controls, shortcuts, libraries, support, export and diagnostic labels to the same service. Native codec labels keep raw probe diagnostics and codec IDs while localizing owned transparency/lossless notes. Locale changes update existing codec and size options in place. New brush defaults use the current language; saved artist names remain data. Library parent destinations show the actual folder name or localized root. Desktop update explanations carry display keys through the existing state transport while retaining English diagnostics. Numeric inputs, filmstrip range handles, graph/canvas coordinates and timeline chronology remain physically LTR in Arabic and Hebrew.

Verification used locked dependencies installed with `npm ci`, Node **24.11.0** and Python **3.12.9** on Linux. Shared outputs were regenerated after the final Polish unit correction. All 26 final raw-pack hashes match the accepted independent reviews. A separate structural audit found 174,668 translated entries, 1,144 plural objects, 3,124 required forms and 176,648 text values, with no unresolved scanned key, placeholder, protected-token, filename, shortcut, corruption or accidental duplicate-caption issue.

| Check actually run | Result and scope |
| --- | --- |
| `npm run locales:build` | Passed; final registry, source context and preload diagnostics regenerated. |
| `npm run locales:validate -- --strict` | Passed; all 26 packs and English have 6,718/6,718 messages, every required plural form and zero fallback; 7,625 source references checked. Every pack author also ran its read-only strict check. |
| `npm run check` | Passed; 1,732 JavaScript files, zero syntax errors; 91 stylesheets and 613 modules, zero CSS lint problems; generated catalogs current. |
| `npm test` | Passed: 3,812 passed, zero failed, 25 skips and one existing TODO (3,838 total). The existing automatic-pose limited/complete TODO remains. |
| `npm run test:localization:browser` | Passed all 438 checks: Settings 18, actual app 12, all-language native-catalog flow 37, retained-control foundation 88 and pack screens 283; no uncaught errors. |
| All-language screen checks | Every non-English locale: all four Settings tabs at 760px. Arabic, Hebrew, German, French, Finnish, Russian, Vietnamese, Chinese, Greek, Turkish, Kazakh and Indonesian also cover all tabs at 390px, with export/timeline checks at that width. The other 14 locales cover export/timeline bounds at 760px. |
| Manual rendered inspection | Settings and export screens in Arabic, Hebrew, Chinese, Vietnamese, Kazakh and Indonesian at 390px, and German Settings at 760px. Earlier reviewed batches also inspected Finnish, Greek, Turkish, Romanian and Dutch. Final Arabic/Hebrew dimensions retain width before height; six real numeric inputs and the trim strip are LTR. |
| Source desktop boot | Passed nine checks under Xvfb: window startup, bridge isolation, codec health, platform/update state and zero page errors; Canvas 2D fallback. |
| Source desktop preferences | Passed: Italian menus and update guidance, saved locale/theme/layout and floating-panel/timeline settings survive restart and origin change; malformed preferences rejected. |
| Source desktop project files | Passed ten checks, including Italian native Save/Save As titles, cancellation, atomic replacement, failed/aborted save preservation and capability invalidation. Used an unchanged locally generated 996-byte Pivot sample. |
| Source desktop video export | Passed after the final display fix: real MP4, WebM, AVI, WMV and GIF outputs each decoded ten frames through the bundled encoder. |
| Update and release-note checks | 34 focused update/AppImage/release-asset/changelog tests passed; `npm run release:prepare`, `npm run changelog:check` and `git diff --check` passed. Preparation leaves the current published notes and version unchanged; completed outcomes are in Unreleased. |

The final shared diff received a separate read-only code review, including lifecycle cleanup, display-only metadata, retained option identity, and preservation of document/export arguments. The RTL dimension fix has a rendered regression: actual text ranges must place width before height in Arabic and Hebrew. Chinese caption checks now distinguish the immutable imported Pivot seed from the reviewed current generic Save/Open and project-opening messages; provenance checks remain intact.

Separate broader browser workflows also ran during the reviewed milestones: app dialogs, motion paths, asset library (including the 20,000-definition case), export sheet, movieclip extension, color palettes, spatial editing and VFX gestures passed. Four older suites still fail on the unchanged baseline: inspector-header expects obsolete joint quick actions; shell-layout expects the old folded Audio-header command; playback-quiet observes existing onion-marker writes; inbetween-dialog calls the removed SimpleTimeline.showMenu API. Their expectations were not weakened. The affected localized headings, panel movement, retained dialogs and progress have separate passing checks in the final foundation suite.

Remaining limits: native specialist-language preferences in the table are unconfirmed. Linux font loading, measured samples and the inspected screens do not certify every glyph or Windows/macOS fonts. Desktop checks cover source Linux execution and a small synthetic Pivot fixture, not packaged Windows/macOS rendering, installed VFW drivers, physical WebGPU behavior or the unavailable private complex-animation sample. These checks do not exhaust every application screen. No native-speaker review, release, push or publication is claimed.
