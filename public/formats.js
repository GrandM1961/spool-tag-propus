const formats = {
  FORMATS: {
    'openspool_extended': { module: OpenSpool, label: 'OpenSpool - Snapmaker U1 Extended (JSON)', hidden: false },
    'openspool_compat': { module: OpenSpool, label: 'OpenSpool - Compat (JSON)', hidden: false },
    'openprinttag': { module: OpenPrintTag, label: 'OpenPrintTag (CBOR)', hidden: true }
  },

  availableFormats(withHidden = false) {
    return Object.entries(this.FORMATS)
      .filter(([id, cfg]) => withHidden || !cfg.hidden)
      .map(([id, cfg]) => ({ id, label: cfg.label, hidden: !!cfg.hidden }));
  },

  getDisplayName(format) {
    const cfg = this.FORMATS[format];
    return cfg ? cfg.label : format;
  },

  availableFields(format, formData) {
    if (!this.FORMATS[format])
      return null;
    return this.FORMATS[format].module.availableFields(formData);
  },

  generateData(format, formData) {
    if (!this.FORMATS[format])
      throw new Error(`Unknown format: ${format}`);
    return this.FORMATS[format].module.generateData(formData);
  },

  createNDEFRecord(format, data) {
    if (!this.FORMATS[format])
      throw new Error(`Unknown format: ${format}`);
    return this.FORMATS[format].module.createNDEFRecord(data);
  },

  parseNDEFRecord(record) {
    const openspoolData = OpenSpool.parseNDEFRecord(record);
    if (openspoolData) {
      return { format: openspoolData.format || 'openspool', data: openspoolData };
    }

    const openprinttagData = OpenPrintTag.parseNDEFRecord(record);
    if (openprinttagData) {
      return { format: 'openprinttag', data: openprinttagData };
    }

    return null;
  },

  parseData(format, buffer) {
    if (!this.FORMATS[format])
      throw new Error(`Unknown format: ${format}`);
    return this.FORMATS[format].module.parseData(buffer);
  },

  download(format, data) {
    if (!this.FORMATS[format])
      throw new Error(`Unknown format: ${format}`);
    return this.FORMATS[format].module.download(data);
  },

  getFileExtension(format) {
    if (!this.FORMATS[format])
      throw new Error(`Unknown format: ${format}`);
    return this.FORMATS[format].module.getFileExtension(format);
  },

  detectFormatFromFilename(filename) {
    for (const key in this.FORMATS) {
      if (filename.endsWith(this.FORMATS[key].module.getFileExtension(key))) {
        return key;
      }
    }
    return null;
  },

  calculateRecordSize(format, formData) {
    try {
      const data = this.generateData(format, formData);
      const records = this.createNDEFRecord(format, data);

      let totalSize = 0;
      for (const record of records) {
        const mediaType = record.mediaType;
        const payloadSize = record.data.byteLength || record.data.length;

        let headerSize = 2;
        if (payloadSize < 256) {
          headerSize += 1;
        } else {
          headerSize += 4;
        }

        const typeLength = mediaType.length;
        const recordSize = headerSize + typeLength + payloadSize;
        totalSize += recordSize;
      }

      return totalSize;
    } catch (e) {
      return 0;
    }
  }
};
