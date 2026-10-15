/**
 * Sample content package — biology / animal cell (one of the MVP subjects, TZ §1).
 *
 * This is a realistic, schema-valid topic used as a fixture for tests and as a
 * reference for authors. It demonstrates: a container shell (membrane) that must
 * not steal clicks (W-21), per-scene overrides (W-31), a process with steps that
 * reference concepts (W-42), a comparison (W-44) and a quiz (W-45).
 */
import type { ContentPackage } from '../index.js';

export const animalCellPackage: ContentPackage = {
  version: '1.0.0',
  subject: {
    id: 'subj-bio',
    slug: 'bio',
    title: { ky: 'Биология', ru: 'Биология', en: 'Biology' },
    icon: 'leaf',
    hue: 140,
    group: 'natural',
    status: 'available',
  },
  topics: [
    {
      id: 'topic-animal-cell',
      subjectId: 'subj-bio',
      slug: 'animal-cell',
      grade: 'g7',
      title: {
        ky: 'Жаныбар клеткасы',
        ru: 'Животная клетка',
        en: 'Animal cell',
      },
      classification: {
        ky: 'Эукариот клетка',
        ru: 'Эукариотическая клетка',
        en: 'Eukaryotic cell',
      },
      description: {
        ky: 'Жаныбар клеткасынын түзүлүшү жана негизги органеллалары.',
        ru: 'Строение животной клетки и её основные органеллы.',
        en: 'The structure of an animal cell and its main organelles.',
      },
      goal: {
        ky: 'Негизги органеллаларды таанып, кызматын түшүндүрүү.',
        ru: 'Узнать основные органеллы и объяснить их функции.',
        en: 'Identify the main organelles and explain their functions.',
      },
      programCode: 'BIO-7.2.1',
      scene: {
        plugin: 'glb',
        modelRef: 'models/animal-cell.glb',
        modes: ['section'],
        overrides: {
          'bio.nucleus': { colorHue: 280 },
        },
      },
      concepts: [
        {
          id: 'bio.membrane',
          slug: 'membrane',
          title: {
            ky: 'Клетка мембранасы',
            ru: 'Клеточная мембрана',
            en: 'Cell membrane',
          },
          description: {
            ky: 'Клетканы курчап турган тандамалуу тоскоол.',
            ru: 'Избирательный барьер, окружающий клетку.',
            en: 'The selective barrier surrounding the cell.',
          },
          container: true,
          properties: [
            {
              type: 'shape',
              label: { ky: 'Форма', ru: 'Форма', en: 'Shape' },
              value: 'bilayer',
            },
          ],
          relatedIds: ['bio.nucleus'],
        },
        {
          id: 'bio.nucleus',
          slug: 'nucleus',
          title: { ky: 'Ядро', ru: 'Ядро', en: 'Nucleus' },
          subtitle: {
            ky: 'Башкаруу борбору',
            ru: 'Центр управления',
            en: 'Control center',
          },
          description: {
            ky: 'Генетикалык маалыматты сактайт.',
            ru: 'Хранит генетическую информацию.',
            en: 'Stores the genetic information.',
          },
          container: false,
          colorHue: 280,
          properties: [
            {
              type: 'size',
              label: { ky: 'Өлчөм', ru: 'Размер', en: 'Size' },
              value: 6,
              unit: 'µm',
            },
          ],
          fact: {
            ky: 'Ядродо ДНК сакталат.',
            ru: 'В ядре хранится ДНК.',
            en: 'DNA is stored in the nucleus.',
          },
          relatedIds: ['bio.membrane'],
          anchor: [0, 0, 0],
        },
        {
          id: 'bio.mitochondrion',
          slug: 'mitochondrion',
          title: {
            ky: 'Митохондрия',
            ru: 'Митохондрия',
            en: 'Mitochondrion',
          },
          description: {
            ky: 'Клетканын энергия станциясы.',
            ru: 'Энергетическая станция клетки.',
            en: 'The powerhouse of the cell.',
          },
          container: false,
          properties: [
            {
              type: 'size',
              label: { ky: 'Өлчөм', ru: 'Размер', en: 'Size' },
              value: 1,
              unit: 'µm',
            },
          ],
          relatedIds: [],
        },
      ],
      processes: [
        {
          id: 'proc-respiration',
          title: {
            ky: 'Клеткалык дем алуу',
            ru: 'Клеточное дыхание',
            en: 'Cellular respiration',
          },
          description: {
            ky: 'Глюкозадан энергия алуу.',
            ru: 'Получение энергии из глюкозы.',
            en: 'Releasing energy from glucose.',
          },
          equation: 'C_6H_{12}O_6 + 6O_2 -> 6CO_2 + 6H_2O',
          engine: 'timeline',
          metrics: ['atp', 'o2'],
          steps: [
            {
              index: 0,
              title: { ky: 'Гликолиз', ru: 'Гликолиз', en: 'Glycolysis' },
              description: {
                ky: 'Глюкоза пируватка ажырайт.',
                ru: 'Глюкоза расщепляется до пирувата.',
                en: 'Glucose is split into pyruvate.',
              },
              conceptId: 'bio.mitochondrion',
              result: { ky: '2 АТФ', ru: '2 АТФ', en: '2 ATP' },
            },
          ],
        },
      ],
      comparison: {
        columnConceptIds: ['bio.nucleus', 'bio.mitochondrion'],
        propertyTypes: ['size'],
      },
      quiz: [
        {
          id: 'q-powerhouse',
          prompt: {
            ky: 'Клетканын энергия станциясы кайсы?',
            ru: 'Что является энергетической станцией клетки?',
            en: 'Which organelle is the powerhouse of the cell?',
          },
          options: [
            {
              id: 'a',
              text: { ky: 'Ядро', ru: 'Ядро', en: 'Nucleus' },
            },
            {
              id: 'b',
              text: {
                ky: 'Митохондрия',
                ru: 'Митохондрия',
                en: 'Mitochondrion',
              },
            },
          ],
          correctOptionId: 'b',
          conceptId: 'bio.mitochondrion',
        },
      ],
    },
  ],
  glossary: [
    {
      id: 'g-organelle',
      term: { ky: 'Органелла', ru: 'Органелла', en: 'Organelle' },
      definition: {
        ky: 'Клетканын ичиндеги адистешкен түзүлүш.',
        ru: 'Специализированная структура внутри клетки.',
        en: 'A specialized structure inside a cell.',
      },
      conceptId: 'bio.nucleus',
    },
  ],
};
