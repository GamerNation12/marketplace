import React from "react";
import type { Option } from "react-dropdown";
import { withTranslation } from "react-i18next";
import semver from "semver";

const Spicetify = window.Spicetify;

import { ITEMS_PER_REQUEST, LATEST_RELEASE_URL, LOCALSTORAGE_KEYS, MARKETPLACE_VERSION } from "../constants";
import { fetchCssSnippets, getBlacklist } from "../logic/FetchRemotes";
import { openModal } from "../logic/LaunchModals";
import { generateSchemesOptions, generateSortOptions, getLocalStorageDataFromKey, injectColourScheme, sortCardItems } from "../logic/Utils";
import type { CardItem, CardType, Config, SchemeIni, Snippet, TabItemConfig } from "../types/marketplace-types";
import Button from "./Button";
import Card, { type Card as CardClass } from "./Card/Card";
import DownloadIcon from "./Icons/DownloadIcon";
import LoadingIcon from "./Icons/LoadingIcon";
import LoadMoreIcon from "./Icons/LoadMoreIcon";
import SettingsIcon from "./Icons/SettingsIcon";
import ThemeDeveloperToolsIcon from "./Icons/ThemeDeveloperToolsIcon";
import SortBox from "./Sortbox";
import { TopBarContent } from "./TabBar";
import Tooltip from "./Tooltip";

class Grid extends React.Component<
  {
    title: string;
    CONFIG: Config;
    updateAppConfig: (CONFIG: Config) => void;
    t: (key: string) => string;
  },
  {
    version: string;
    newUpdate: boolean;
    searchValue: string;
    cards: CardClass[];
    tabs: TabItemConfig[];
    rest: boolean;
    endOfList: boolean;
    activeThemeKey?: string;
    schemes: SchemeIni;
    activeScheme?: string | null;
  }
> {
  constructor(props) {
    super(props);
    Object.assign(this, props);
    this.updateAppConfig = props.updateAppConfig.bind(this);

    this.sortConfig = {
      by: getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.sort, "top")
    };

    this.state = {
      version: MARKETPLACE_VERSION,
      newUpdate: false,
      searchValue: "",
      cards: [],
      tabs: props.CONFIG.tabs,
      rest: true,
      endOfList: false,
      schemes: props.CONFIG.theme.schemes,
      activeScheme: props.CONFIG.theme.activeScheme,
      activeThemeKey: props.CONFIG.theme.activeThemeKey
    };
  }

  searchRequested: boolean;
  endOfList = false;
  lastScroll = 0;
  requestQueue: never[][] = [];
  requestPage = 0;
  cardList: CardClass[] = [];
  sortConfig: { by: string };
  gridUpdateTabs: (() => void) | null;
  gridUpdatePostsVisual: (() => void) | null;
  checkScroll: (e: Event) => void;
  CONFIG: Config;
  updateAppConfig: (CONFIG: Config) => void;
  BLACKLIST: string[] | undefined;
  SNIPPETS: Snippet[] | undefined;

  getInstalledTheme() {
    const installedThemeKey = localStorage.getItem(LOCALSTORAGE_KEYS.themeInstalled);
    if (!installedThemeKey) return null;
    const installedThemeDataStr = localStorage.getItem(installedThemeKey);
    if (!installedThemeDataStr) return null;
    return JSON.parse(installedThemeDataStr);
  }

  newRequest(amount: number | undefined) {
    this.cardList = [];
    const queue = [];
    this.requestQueue.unshift(queue);
    this.loadAmount(queue, amount);
  }

  appendCard(item: CardItem | Snippet, type: CardType, activeTab: string) {
    if (activeTab !== this.props.CONFIG.activeTab) return;

    const card = (
      <Card
        item={item}
        key={`${this.props.CONFIG.activeTab}:${item.user}:${item.title}`}
        CONFIG={this.CONFIG}
        visual={this.props.CONFIG.visual}
        type={type}
        activeThemeKey={this.state.activeThemeKey}
        updateColourSchemes={this.updateColourSchemes.bind(this)}
        updateActiveTheme={this.setActiveTheme.bind(this)}
      />
    );

    this.cardList.push(card as unknown as CardClass);
  }

  updateSort(sortByValue) {
    if (sortByValue) {
      this.sortConfig.by = sortByValue;
      localStorage.setItem(LOCALSTORAGE_KEYS.sort, sortByValue);
    }
    this.requestPage = 0;
    this.cardList = [];
    this.setState({ cards: [], rest: false, endOfList: false });
    this.endOfList = false;
    this.newRequest(ITEMS_PER_REQUEST);
  }

  updateTabs() {
    this.setState({ tabs: [...this.props.CONFIG.tabs] });
  }

  updatePostsVisual() {
    this.cardList = this.cardList.map((card, index) => {
      return <Card {...card.props} key={index.toString()} CONFIG={this.CONFIG} />;
    }) as unknown as CardClass[];
    this.setState({ cards: [...this.cardList] });
  }

  switchTo(option: Option) {
    this.CONFIG.activeTab = option.value;
    localStorage.setItem(LOCALSTORAGE_KEYS.activeTab, option.value);
    this.cardList = [];
    this.requestPage = 0;
    this.setState({ cards: [], rest: false, endOfList: false });
    this.endOfList = false;
    this.newRequest(ITEMS_PER_REQUEST);
  }

  async loadPage(queue: never[]) {
    const activeTab = this.CONFIG.activeTab;
    switch (activeTab) {
      case "Extensions": {
        // Fetch Official Extensions
        const officialRes = await fetch("https://raw.githubusercontent.com/spicetify/spicetify-marketplace/main/resources/extensions.json");
        const officialExtensions = await officialRes.json();

        // Fetch Your Custom Extensions
        let customExtensions = [];
        try {
          const customRes = await fetch("https://raw.githubusercontent.com/GamerNation12/marketplace/main/resources/extensions.json");
          customExtensions = await customRes.json();
        } catch (e) {
          console.log("No custom extensions found yet.");
        }

        // Merge them together!
        const extensions = [...customExtensions, ...officialExtensions];

        if (this.requestQueue.length > 1 && queue !== this.requestQueue[0]) return -1;
        sortCardItems(extensions, localStorage.getItem("marketplace:sort") || "stars");
        for (const extension of extensions) {
          this.appendCard(extension, "extension", activeTab);
        }
        this.setState({ cards: this.cardList });
        return 0;
      }
      case "Themes": {
        // Fetch Official Themes
        const officialRes = await fetch("https://raw.githubusercontent.com/spicetify/spicetify-marketplace/main/resources/themes.json");
        const officialThemes = await officialRes.json();

        // Fetch Your Custom Themes
        let customThemes = [];
        try {
          const customRes = await fetch("https://raw.githubusercontent.com/GamerNation12/marketplace/main/resources/themes.json");
          customThemes = await customRes.json();
        } catch (e) {
          console.log("No custom themes found yet.");
        }

        // Merge them together!
        const themes = [...customThemes, ...officialThemes];

        if (this.requestQueue.length > 1 && queue !== this.requestQueue[0]) return -1;
        sortCardItems(themes, localStorage.getItem("marketplace:sort") || "stars");
        for (const theme of themes) {
          this.appendCard(theme, "theme", activeTab);
        }
        this.setState({ cards: this.cardList });
        return 0;
      }
      case "Installed": {
        const installedStuff = {
          theme: getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.installedThemes, []),
          extension: getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.installedExtensions, []),
          snippet: getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.installedSnippets, [])
        };
        for (const type in installedStuff) {
          if (installedStuff[type].length) {
            const installedOfType: CardItem[] = [];
            for (const itemKey of installedStuff[type]) {
              const installedItem = getLocalStorageDataFromKey(itemKey);
              if (this.requestQueue.length > 1 && queue !== this.requestQueue[0]) return -1;
              installedOfType.push(installedItem);
            }
            sortCardItems(installedOfType, localStorage.getItem("marketplace:sort") || "stars");
            for (const item of installedOfType) {
              this.appendCard(item, type as CardType, activeTab);
            }
          }
        }
        this.setState({ cards: this.cardList });
        break;
      }
      case "Snippets": {
        const snippets = this.SNIPPETS;
        if (this.requestQueue.length > 1 && queue !== this.requestQueue[0]) return -1;
        if (snippets?.length) {
          sortCardItems(snippets, localStorage.getItem("marketplace:sort") || "stars");
          for (const snippet of snippets) {
            this.appendCard(snippet, "snippet", activeTab);
          }
          this.setState({ cards: this.cardList });
        }
      }
    }
    this.setState({ rest: true, endOfList: true });
    this.endOfList = true;
    return 0;
  }

  async loadAmount(queue: never[], quantity: number = ITEMS_PER_REQUEST) {
    this.setState({ rest: false });
    const maxCardQuantity = this.cardList.length + quantity;
    this.requestPage = await this.loadPage(queue);
    while (this.requestPage && this.requestPage !== -1 && this.cardList.length < maxCardQuantity && !this.state.endOfList) {
      this.requestPage = await this.loadPage(queue);
    }
    if (this.requestPage === -1) {
      this.requestQueue = this.requestQueue.filter((a) => a !== queue);
      return;
    }
    this.requestQueue.shift();
    this.setState({ rest: true });
  }

  loadMore() {
    if (this.state.rest && !this.endOfList) {
      this.loadAmount(this.requestQueue[0], ITEMS_PER_REQUEST);
    }
  }

  updateColourSchemes(schemes: SchemeIni, activeScheme: string | null) {
    this.CONFIG.theme.schemes = schemes;
    this.CONFIG.theme.activeScheme = activeScheme;
    if (activeScheme) (Spicetify.Config as { [key: string]: unknown }).color_scheme = activeScheme;

    if (schemes && activeScheme && schemes[activeScheme]) {
      injectColourScheme(this.CONFIG.theme.schemes[activeScheme]);
    } else {
      injectColourScheme(null);
    }

    const installedThemeKey = getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.themeInstalled);
    const installedThemeData = getLocalStorageDataFromKey(installedThemeKey);
    if (installedThemeData) {
      installedThemeData.activeScheme = activeScheme;
      localStorage.setItem(installedThemeKey, JSON.stringify(installedThemeData));
    }
    this.setState({ schemes, activeScheme });
  }

  async componentDidMount() {
    fetch(LATEST_RELEASE_URL)
      .then((res) => res.json())
      .then(
        (result) => {
          if (result.message) throw result;
          this.setState({ version: result.name });
          try {
            this.setState({ newUpdate: semver.gt(result.name, MARKETPLACE_VERSION) });
          } catch (err) {
            console.error(err);
          }
        },
        (error) => {
          console.error("Failed to check for updates", error);
        }
      );

    this.gridUpdateTabs = this.updateTabs.bind(this);
    this.gridUpdatePostsVisual = this.updatePostsVisual.bind(this);

    const viewPort = document.querySelector(".os-viewport") ?? document.querySelector("#main .main-view-container__scroll-node");
    this.checkScroll = this.isScrolledBottom.bind(this);
    if (viewPort) {
      viewPort.addEventListener("scroll", this.checkScroll);
      if (this.cardList.length) {
        if (this.lastScroll > 0) viewPort.scrollTo(0, this.lastScroll);
        return;
      }
    }

    this.BLACKLIST = await getBlacklist();
    this.SNIPPETS = await fetchCssSnippets(this.CONFIG.visual.hideInstalled);
    this.newRequest(ITEMS_PER_REQUEST);
  }

  componentWillUnmount(): void {
    this.gridUpdateTabs = this.gridUpdatePostsVisual = null;
    const viewPort = document.querySelector(".os-viewport") ?? document.querySelector("#main .main-view-container__scroll-node");
    if (viewPort) {
      this.lastScroll = viewPort.scrollTop;
      viewPort.removeEventListener("scroll", this.checkScroll);
    }
  }

  isScrolledBottom(event: Event): void {
    const viewPort = event.target as HTMLElement;
    if (viewPort.scrollTop + viewPort.clientHeight >= viewPort.scrollHeight) {
      this.loadMore();
    }
  }

  setActiveTheme(themeKey: string) {
    this.CONFIG.theme.activeThemeKey = themeKey;
    this.setState({ activeThemeKey: themeKey });
  }

  getActiveScheme() {
    return this.state.activeScheme;
  }

  render() {
    const { t } = this.props;
    return (
      <section className="contentSpacing">
        <div className="marketplace-header">
          <div className="marketplace-header__left">
            {this.state.newUpdate ? (
              <button type="button" title={t("grid.newUpdate")} className="marketplace-header-icon-button" onClick={() => openModal("UPDATE")}>
                <DownloadIcon />
                &nbsp;{this.state.version}
              </button>
            ) : null}
            <h2 className="marketplace-header__label">{t("grid.sort.label")}</h2>
            <SortBox
              onChange={(value) => this.updateSort(value)}
              sortBoxOptions={generateSortOptions(t)}
              sortBySelectedFn={(a) => a.key === this.CONFIG.sort}
            />
          </div>
          <div className="marketplace-header__right">
            {this.CONFIG.visual.themeDevTools ? (
              <Tooltip label={t("devTools.title")} renderInline={true} placement="bottom">
                <button type="button" className="marketplace-header-icon-button" onClick={() => openModal("THEME_DEV_TOOLS")}>
                  <ThemeDeveloperToolsIcon />
                </button>
              </Tooltip>
            ) : null}
            {this.state.activeScheme ? (
              <SortBox
                onChange={(value) => this.updateColourSchemes(this.state.schemes, value)}
                sortBoxOptions={generateSchemesOptions(this.state.schemes)}
                sortBySelectedFn={(a) => a.key === this.getActiveScheme()}
              />
            ) : null}
            <div className="searchbar--bar__wrapper">
              <input
                className="searchbar-bar"
                type="text"
                placeholder={`${t("grid.search")} ${t(`tabs.${this.CONFIG.activeTab}`)}...`}
                value={this.state.searchValue}
                onChange={(e) => this.setState({ searchValue: e.target.value })}
              />
            </div>
            <Tooltip label={t("settings.title")} renderInline={true} placement="bottom">
              <button
                type="button"
                className="marketplace-header-icon-button"
                onClick={() => openModal("SETTINGS", this.CONFIG, this.updateAppConfig)}
              >
                <SettingsIcon />
              </button>
            </Tooltip>
          </div>
        </div>
        {[
          { handle: "extension", name: "Extensions" },
          { handle: "theme", name: "Themes" },
          { handle: "snippet", name: "Snippets" },
          { handle: "app", name: "Apps" }
        ].map((cardType) => {
          const cardsOfType = this.cardList
            .filter((card) => card.props.type === cardType.handle)
            .filter((card) => {
              const searchValue = this.state.searchValue.trim().toLowerCase();
              const { title, user, authors, tags } = card.props.item;
              return (
                !searchValue ||
                title.toLowerCase().includes(searchValue) ||
                user?.toLowerCase().includes(searchValue) ||
                authors?.some((author) => author.name.toLowerCase().includes(searchValue)) ||
                [...(tags ?? [])]?.some((tag) => tag.toLowerCase().includes(searchValue))
              );
            })
            .map((card) => React.cloneElement(card, { activeThemeKey: this.state.activeThemeKey, key: card.key }))
            .filter((card, index, cards) => cards.findIndex((c) => c.key === card.key) === index);

          if (cardsOfType.length) {
            return (
              <div className="marketplace-content" key={cardType.handle}>
                <h2 className="marketplace-card-type-heading">{t(`tabs.${cardType.name}`)}</h2>
                <div
                  className="marketplace-grid main-gridContainer-gridContainer main-gridContainer-fixedWidth"
                  data-tab={this.CONFIG.activeTab}
                  data-card-type={t(`tabs.${cardType.name}`)}
                >
                  {cardsOfType}
                </div>
              </div>
            );
          }
          return null;
        })}
        {this.CONFIG.activeTab === "Snippets" ? (
          <Button classes={["marketplace-add-snippet-btn"]} onClick={() => openModal("ADD_SNIPPET")}>
            + {t("grid.addCSS")}
          </Button>
        ) : null}
        <footer className="marketplace-footer">
          {!this.state.endOfList ? (
            this.state.rest && this.state.cards.length > 0 ? (
              <LoadMoreIcon onClick={this.loadMore.bind(this)} />
            ) : (
              <LoadingIcon />
            )
          ) : (
            <div style={{ height: "64px" }} />
          )}
        </footer>
        <TopBarContent switchCallback={this.switchTo.bind(this)} links={this.CONFIG.tabs} activeLink={this.CONFIG.activeTab} />
      </section>
    );
  }
}

export default withTranslation()(Grid);
