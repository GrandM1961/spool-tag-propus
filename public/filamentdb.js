const FilamentDB = {
  BASE_URL: 'https://api.openfilamentdatabase.org/api/v1',
  cache: {},

  async fetchJson(path) {
    const url = `${this.BASE_URL}/${path}`;
    if (this.cache[url]) return this.cache[url];

    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    this.cache[url] = data;
    return data;
  },

  async getBrands() {
    const data = await this.fetchJson('brands/index.json');
    return data.brands
      .filter(b => b.material_count > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async getMaterials(brandSlug) {
    const data = await this.fetchJson(`brands/${brandSlug}/index.json`);
    return {
      brand: data,
      materials: (data.materials || []).sort((a, b) => a.material.localeCompare(b.material))
    };
  },

  async getFilaments(brandSlug, materialSlug) {
    const data = await this.fetchJson(`brands/${brandSlug}/materials/${materialSlug}/index.json`);
    return {
      material: data,
      filaments: (data.filaments || []).sort((a, b) => a.name.localeCompare(b.name)),
      density: data.density,
      slicerSettings: data.default_slicer_settings
    };
  },

  async getVariants(brandSlug, materialSlug, filamentSlug) {
    const data = await this.fetchJson(
      `brands/${brandSlug}/materials/${materialSlug}/filaments/${filamentSlug}/index.json`
    );
    return {
      filament: data,
      variants: (data.variants || []).sort((a, b) =>
        (a.color_name || '').localeCompare(b.color_name || '')
      ),
      density: data.density
    };
  },

  async getVariantDetail(brandSlug, materialSlug, filamentSlug, variantSlug) {
    const data = await this.fetchJson(
      `brands/${brandSlug}/materials/${materialSlug}/filaments/${filamentSlug}/variants/${variantSlug}.json`
    );
    return data;
  }
};
