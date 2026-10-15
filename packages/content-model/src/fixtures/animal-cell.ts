/**
 * TEST-ONLY fixture — biology / animal cell, in the v0.2 content model.
 *
 * Do NOT import this from app code (bilig_ft/src, bilig_back/src); apps load
 * content from the API / built packages. It demonstrates: a container shell
 * (W-21), topic overrides with anchors (W-22/W-31), a reusable process whose
 * steps reference concepts (W-42), a comparison (W-44), all five item types
 * (W-45), a lesson tour (W-50) and STEM + simple examples in ky/ru/en.
 */
import type { Catalog, ContentPackage, Localized } from '../index.js';
import { summarizeTopic } from '../package.js';

const L = (ky: string, ru: string, en: string): Localized => ({ ky, ru, en });
const H = (c: string) => c.repeat(64).slice(0, 64);

export const animalCellPackage: ContentPackage = {
  manifest: {
    topicKey: 'animal-cell',
    version: '1.0.0',
    hash: H('a1'),
    files: [
      { path: 'models/animal-cell.glb', hash: H('b2'), size: 1_820_000 },
      { path: 'thumbs/animal-cell.webp', hash: H('c3'), size: 24_000 },
      { path: 'thumbs/plant-cell.webp', hash: H('d4'), size: 23_000 },
    ],
    builtAt: '2026-10-01T10:00:00Z',
  },
  subject: {
    key: 'bio',
    title: L('Биология', 'Биология', 'Biology'),
    icon: 'leaf',
    hue: 140,
    group: 'natural',
    order: 0,
    status: 'live',
  },
  course: {
    key: 'bio.g7',
    subjectKey: 'bio',
    grade: 7,
    curriculum: 'kg-2024',
    title: L('Биология, 7-класс', 'Биология, 7 класс', 'Biology, grade 7'),
  },
  unit: {
    key: 'bio.g7.cells',
    courseKey: 'bio.g7',
    order: 1,
    title: L('Клетка', 'Клетка', 'The cell'),
  },
  objectives: [
    {
      key: 'bio.g7.cells.o1',
      code: 'BIO-7.2.1',
      unitKey: 'bio.g7.cells',
      text: L(
        'Клетканын негизги органеллаларын атоо жана милдетин түшүндүрүү.',
        'Называть основные органеллы клетки и объяснять их функции.',
        'Name the main organelles of the cell and explain their functions.',
      ),
    },
  ],
  topic: {
    key: 'animal-cell',
    unitKey: 'bio.g7.cells',
    status: 'published',
    title: L('Жаныбар клеткасы', 'Животная клетка', 'Animal cell'),
    classification: L('Эукариот клетка', 'Эукариотическая клетка', 'Eukaryotic cell'),
    description: L(
      'Жаныбар клеткасынын түзүлүшү жана негизги органеллалары.',
      'Строение животной клетки и её основные органеллы.',
      'The structure of an animal cell and its main organelles.',
    ),
    goal: L(
      'Негизги органеллаларды таанып, кызматын түшүндүрүү.',
      'Узнать основные органеллы и объяснить их функции.',
      'Identify the main organelles and explain their functions.',
    ),
    objectiveKeys: ['bio.g7.cells.o1'],
    durationMin: 40,
    scene: {
      plugin: 'gltf',
      asset: 'models/animal-cell.glb',
      camera: { position: [0, 1.5, 6], target: [0, 0, 0], fov: 45 },
      modes: ['whole', 'section'],
    },
    conceptKeys: ['bio.membrane', 'bio.nucleus', 'bio.mitochondrion'],
    overrides: {
      'bio.nucleus': { anchor: [0, 0.2, 0], nodes: ['Nucleus'] },
      'bio.mitochondrion': {
        anchor: [1.4, -0.3, 0.6],
        nodes: ['Mito_*'],
        subtitle: L('Энергия станциясы', 'Энергостанция', 'Power station'),
      },
      'bio.membrane': { nodes: ['Membrane'] },
    },
    samples: [
      {
        key: 'animal-cell',
        title: L('Жаныбар клеткасы', 'Животная клетка', 'Animal cell'),
        classification: L('Эукариот', 'Эукариот', 'Eukaryote'),
        thumb: 'thumbs/animal-cell.webp',
      },
      {
        key: 'plant-cell',
        title: L('Өсүмдүк клеткасы', 'Растительная клетка', 'Plant cell'),
        classification: L('Эукариот', 'Эукариот', 'Eukaryote'),
        thumb: 'thumbs/plant-cell.webp',
        topicKey: 'plant-cell',
      },
    ],
    activities: {
      tour: {
        steps: [
          {
            key: 'overview',
            camera: { position: [0, 1.5, 6], target: [0, 0, 0] },
            text: L('Бул – жаныбар клеткасы.', 'Это животная клетка.', 'This is an animal cell.'),
            teacherNote: L(
              'Клетканы айлантып көрсөтүңүз.',
              'Покажите клетку со всех сторон.',
              'Rotate the cell to show all sides.',
            ),
            altText: L(
              'Тегерек клетка, ичинде органеллалар.',
              'Круглая клетка с органеллами внутри.',
              'A round cell with organelles inside.',
            ),
          },
          {
            key: 'nucleus',
            focus: 'bio.nucleus',
            visibility: { isolate: ['bio.nucleus'] },
            modes: { view: 'section' },
            text: L('Ядро ДНКны сактайт.', 'Ядро хранит ДНК.', 'The nucleus stores DNA.'),
            altText: L(
              'Клетканын ортосундагы ири ядро.',
              'Крупное ядро в центре клетки.',
              'A large nucleus in the centre of the cell.',
            ),
          },
          {
            key: 'mitochondria',
            focus: 'bio.mitochondrion',
            visibility: { hide: ['bio.membrane'] },
            text: L(
              'Митохондриялар энергия өндүрөт.',
              'Митохондрии вырабатывают энергию.',
              'Mitochondria produce energy.',
            ),
            altText: L(
              'Сүйрү формадагы митохондриялар.',
              'Митохондрии вытянутой формы.',
              'Oval-shaped mitochondria.',
            ),
          },
        ],
      },
      processKeys: ['bio.respiration'],
      comparison: {
        columns: [
          { kind: 'concept', key: 'bio.nucleus' },
          { kind: 'concept', key: 'bio.mitochondrion' },
        ],
        rows: ['size', 'location'],
      },
      quiz: {
        itemKeys: [
          'bio.q.powerhouse',
          'bio.q.organelles',
          'bio.q.match',
          'bio.q.find-nucleus',
          'bio.q.nucleus-size',
        ],
        sampleSize: 3,
      },
    },
    examples: {
      stem: [
        {
          title: L('Клетка өстүрүү', 'Клеточные культуры', 'Cell cultures'),
          text: L(
            'Илимпоздор вакцина жасоо үчүн клеткаларды лабораторияда өстүрүшөт.',
            'Учёные выращивают клетки в лаборатории, чтобы создавать вакцины.',
            'Scientists grow cells in the lab to make vaccines.',
          ),
          field: 's',
        },
        {
          title: L('Микроскоп', 'Микроскоп', 'Microscope'),
          text: L(
            'Оптикалык микроскоп клетканы 1000 эсе чоңойтот.',
            'Оптический микроскоп увеличивает клетку в 1000 раз.',
            'An optical microscope magnifies a cell 1000 times.',
          ),
          field: 't',
        },
      ],
      simple: [
        {
          title: L('Клетка – шаар', 'Клетка – город', 'A cell is a city'),
          text: L(
            'Клетка шаарга окшош: ядро – мэрия, митохондрия – электр станциясы.',
            'Клетка похожа на город: ядро – мэрия, митохондрии – электростанции.',
            'A cell is like a city: the nucleus is city hall, mitochondria are power plants.',
          ),
        },
      ],
    },
    i18n: { ky: 'reviewed', ru: 'reviewed', en: 'draft' },
  },
  concepts: [
    {
      key: 'bio.membrane',
      kind: 'structure',
      hue: 200,
      isContainer: true,
      title: L('Клетка мембранасы', 'Клеточная мембрана', 'Cell membrane'),
      description: L(
        'Клетканы курчап турган тандамалуу тоскоол.',
        'Избирательный барьер, окружающий клетку.',
        'The selective barrier surrounding the cell.',
      ),
      props: [
        { kind: 'quantity', type: 'size', value: 7, max: 10, unit: 'nm' },
        { kind: 'text', type: 'location', value: L('Клетканын сырты', 'Снаружи клетки', 'Outside of the cell') },
      ],
      related: ['bio.nucleus'],
      misconceptions: [],
      analogy: L('Шаардын дубалы', 'Городская стена', 'A city wall'),
      examples: {
        stem: [
          {
            title: L('Суу чыпкалары', 'Фильтры для воды', 'Water filters'),
            text: L(
              'Инженерлер мембрана сыяктуу чыпкалар менен сууну тазалашат.',
              'Инженеры очищают воду фильтрами, похожими на мембрану.',
              'Engineers purify water with membrane-like filters.',
            ),
            field: 'e',
          },
        ],
        simple: [
          {
            title: L('Элек', 'Сито', 'A sieve'),
            text: L(
              'Мембрана элек сыяктуу: кээ бир нерселерди өткөрөт, кээ бирин өткөрбөйт.',
              'Мембрана как сито: что-то пропускает, а что-то нет.',
              'A membrane is like a sieve: it lets some things through and keeps others out.',
            ),
          },
        ],
      },
    },
    {
      key: 'bio.nucleus',
      kind: 'organelle',
      hue: 280,
      isContainer: false,
      title: L('Ядро', 'Ядро', 'Nucleus'),
      subtitle: L('Башкаруу борбору', 'Центр управления', 'Control center'),
      description: L(
        'Генетикалык маалыматты сактайт.',
        'Хранит генетическую информацию.',
        'Stores the genetic information.',
      ),
      props: [
        { kind: 'quantity', type: 'size', value: 6 },
        { kind: 'text', type: 'location', value: L('Клетканын борбору', 'Центр клетки', 'Centre of the cell') },
        { kind: 'text', type: 'foundIn', value: L('Эукариоттор', 'Эукариоты', 'Eukaryotes') },
      ],
      related: ['bio.membrane', 'bio.mitochondrion'],
      misconceptions: [
        {
          key: 'bio.m.nucleus-everywhere',
          text: L(
            'Бардык клеткалардын ядросу бар.',
            'У всех клеток есть ядро.',
            'All cells have a nucleus.',
          ),
          correction: L(
            'Бактериялардын ядросу жок.',
            'У бактерий нет ядра.',
            'Bacteria have no nucleus.',
          ),
        },
      ],
      funFact: L('Ядродо ДНК сакталат.', 'В ядре хранится ДНК.', 'DNA is stored in the nucleus.'),
      analogy: L('Китепкана', 'Библиотека', 'A library'),
      examples: {
        stem: [
          {
            title: L('ДНК анализи', 'Анализ ДНК', 'DNA testing'),
            text: L(
              'Дарыгерлер ядродогу ДНКны изилдеп, ооруларды аныкташат.',
              'Врачи изучают ДНК из ядра, чтобы находить болезни.',
              'Doctors study DNA from the nucleus to detect diseases.',
            ),
            field: 's',
          },
        ],
        simple: [
          {
            title: L('Рецепт китеби', 'Книга рецептов', 'A recipe book'),
            text: L(
              'Ядро – клетканын рецепт китеби: эмнени жана качан жасоо керектигин айтат.',
              'Ядро – книга рецептов клетки: говорит, что и когда делать.',
              'The nucleus is the cell’s recipe book: it says what to make and when.',
            ),
          },
        ],
      },
    },
    {
      key: 'bio.mitochondrion',
      kind: 'organelle',
      hue: 20,
      isContainer: false,
      title: L('Митохондрия', 'Митохондрия', 'Mitochondrion'),
      description: L(
        'Клетканын энергия станциясы.',
        'Энергетическая станция клетки.',
        'The powerhouse of the cell.',
      ),
      props: [{ kind: 'quantity', type: 'size', value: 1, approx: true }],
      related: ['bio.nucleus'],
      misconceptions: [
        {
          key: 'bio.m.mito-makes-energy',
          text: L(
            'Митохондрия энергияны жоктон жаратат.',
            'Митохондрия создаёт энергию из ничего.',
            'Mitochondria create energy from nothing.',
          ),
          correction: L(
            'Ал глюкозадагы энергияны АТФка айландырат.',
            'Она превращает энергию глюкозы в АТФ.',
            'They convert the energy of glucose into ATP.',
          ),
        },
      ],
      examples: {
        stem: [
          {
            title: L('Спорт илими', 'Спортивная наука', 'Sports science'),
            text: L(
              'Машыгуу булчуңдагы митохондриялардын санын көбөйтөт.',
              'Тренировки увеличивают число митохондрий в мышцах.',
              'Training increases the number of mitochondria in muscles.',
            ),
            field: 's',
          },
        ],
        simple: [
          {
            title: L('Батарейка', 'Батарейка', 'A battery'),
            text: L(
              'Митохондрия батарейкадай клетканы кубаттайт.',
              'Митохондрия заряжает клетку, как батарейка.',
              'A mitochondrion powers the cell like a battery.',
            ),
          },
        ],
      },
    },
  ],
  processes: [
    {
      key: 'bio.respiration',
      engine: 'timeline',
      title: L('Клеткалык дем алуу', 'Клеточное дыхание', 'Cellular respiration'),
      icon: 'wind',
      description: L(
        'Глюкозадан энергия алуу.',
        'Получение энергии из глюкозы.',
        'Releasing energy from glucose.',
      ),
      equation: 'C_6H_{12}O_6 + 6O_2 \\to 6CO_2 + 6H_2O',
      inputs: L('Глюкоза + кычкылтек', 'Глюкоза + кислород', 'Glucose + oxygen'),
      outputs: L('Көмүр кычкыл газы + суу', 'Углекислый газ + вода', 'Carbon dioxide + water'),
      energy: L('≈ 30 АТФ', '≈ 30 АТФ', '≈ 30 ATP'),
      steps: [
        {
          key: 'glycolysis',
          title: L('Гликолиз', 'Гликолиз', 'Glycolysis'),
          result: L('2 АТФ', '2 АТФ', '2 ATP'),
          description: L(
            'Глюкоза пируватка ажырайт.',
            'Глюкоза расщепляется до пирувата.',
            'Glucose is split into pyruvate.',
          ),
          altText: L('Глюкоза экиге бөлүнөт.', 'Глюкоза делится надвое.', 'Glucose splits in two.'),
          duration: 2,
        },
        {
          key: 'krebs',
          title: L('Кребс цикли', 'Цикл Кребса', 'Krebs cycle'),
          result: L('2 АТФ', '2 АТФ', '2 ATP'),
          description: L(
            'Пируват митохондрияда кычкылданат.',
            'Пируват окисляется в митохондрии.',
            'Pyruvate is oxidised in the mitochondrion.',
          ),
          conceptKey: 'bio.mitochondrion',
          altText: L('Митохондриядагы цикл.', 'Цикл внутри митохондрии.', 'A cycle inside the mitochondrion.'),
          duration: 3,
        },
        {
          key: 'etc',
          title: L('Электрон ташуу чынжыры', 'Дыхательная цепь', 'Electron transport chain'),
          result: L('≈ 26 АТФ', '≈ 26 АТФ', '≈ 26 ATP'),
          description: L(
            'АТФтын көбү ушул жерде пайда болот.',
            'Здесь образуется большая часть АТФ.',
            'Most ATP is made here.',
          ),
          conceptKey: 'bio.mitochondrion',
          altText: L('Мембранадагы белоктор.', 'Белки на мембране.', 'Proteins on a membrane.'),
        },
      ],
      metrics: [
        { key: 'atp', label: L('АТФ', 'АТФ', 'ATP'), min: 0, max: 30, precision: 0 },
        { key: 'o2', label: L('O₂', 'O₂', 'O₂'), unit: 'mol', min: 0, max: 6, precision: 1 },
      ],
    },
  ],
  items: [
    {
      key: 'bio.q.powerhouse',
      type: 'single',
      prompt: L(
        'Клетканын энергия станциясы кайсы?',
        'Что является энергетической станцией клетки?',
        'Which organelle is the powerhouse of the cell?',
      ),
      options: [
        { key: 'a', text: L('Ядро', 'Ядро', 'Nucleus') },
        { key: 'b', text: L('Митохондрия', 'Митохондрия', 'Mitochondrion') },
        { key: 'c', text: L('Мембрана', 'Мембрана', 'Membrane') },
      ],
      answer: 'b',
      explanation: L(
        'Митохондрия АТФ өндүрөт.',
        'Митохондрия вырабатывает АТФ.',
        'The mitochondrion produces ATP.',
      ),
      objectiveKeys: ['bio.g7.cells.o1'],
      misconceptionKey: 'bio.m.mito-makes-energy',
      difficulty: 1,
    },
    {
      key: 'bio.q.organelles',
      type: 'multiple',
      prompt: L(
        'Кайсылары органелла?',
        'Что из этого органеллы?',
        'Which of these are organelles?',
      ),
      options: [
        { key: 'a', text: L('Ядро', 'Ядро', 'Nucleus') },
        { key: 'b', text: L('Митохондрия', 'Митохондрия', 'Mitochondrion') },
        { key: 'c', text: L('Глюкоза', 'Глюкоза', 'Glucose') },
      ],
      answer: ['a', 'b'],
      explanation: L(
        'Глюкоза – молекула, органелла эмес.',
        'Глюкоза – молекула, а не органелла.',
        'Glucose is a molecule, not an organelle.',
      ),
      objectiveKeys: ['bio.g7.cells.o1'],
      difficulty: 2,
    },
    {
      key: 'bio.q.match',
      type: 'match',
      prompt: L('Түзүлүштү милдети менен дал келтир.', 'Сопоставь структуру и функцию.', 'Match structure to function.'),
      pairs: [
        { key: 'nucleus', left: L('Ядро', 'Ядро', 'Nucleus'), right: L('ДНКны сактайт', 'Хранит ДНК', 'Stores DNA') },
        { key: 'mito', left: L('Митохондрия', 'Митохондрия', 'Mitochondrion'), right: L('АТФ өндүрөт', 'Делает АТФ', 'Makes ATP') },
      ],
      explanation: L('Ар бир органелланын өз милдети бар.', 'У каждой органеллы своя функция.', 'Each organelle has its own job.'),
      objectiveKeys: ['bio.g7.cells.o1'],
      difficulty: 2,
    },
    {
      key: 'bio.q.find-nucleus',
      type: 'find-on-model',
      prompt: L('Моделден ядрону тап.', 'Найди ядро на модели.', 'Find the nucleus on the model.'),
      targetConceptKey: 'bio.nucleus',
      explanation: L('Ядро клетканын борборунда.', 'Ядро в центре клетки.', 'The nucleus is in the centre.'),
      objectiveKeys: ['bio.g7.cells.o1'],
      misconceptionKey: 'bio.m.nucleus-everywhere',
      difficulty: 1,
    },
    {
      key: 'bio.q.nucleus-size',
      type: 'numeric',
      prompt: L('Ядронун өлчөмү канча мкм?', 'Каков размер ядра в мкм?', 'How big is the nucleus in µm?'),
      answer: 6,
      tolerance: 1,
      unit: 'µm',
      explanation: L('Болжол менен 6 мкм.', 'Около 6 мкм.', 'About 6 µm.'),
      objectiveKeys: ['bio.g7.cells.o1'],
      difficulty: 3,
    },
  ],
  glossary: [
    {
      id: 'g-organelle',
      ky: 'органелла',
      ru: 'органелла',
      en: 'organelle',
      forbidden: ['органоид'],
      approvedBy: 'editor-bio',
    },
  ],
};

/** A catalog built around the fixture, plus a locked «Скоро» subject. */
export const animalCellCatalog: Catalog = {
  groups: [
    { key: 'natural', title: L('Табигый', 'Естественные', 'Natural'), order: 0 },
    { key: 'exact', title: L('Так илимдер', 'Точные', 'Exact'), order: 1 },
    { key: 'earth-space', title: L('Жер жана космос', 'Земля и космос', 'Earth & Space'), order: 2 },
  ],
  subjects: [
    animalCellPackage.subject,
    {
      key: 'chem',
      title: L('Химия', 'Химия', 'Chemistry'),
      icon: 'flask',
      hue: 265,
      group: 'natural',
      order: 1,
      status: 'soon',
    },
  ],
  courses: [animalCellPackage.course!],
  units: [animalCellPackage.unit!],
  topics: [summarizeTopic(animalCellPackage)],
};
