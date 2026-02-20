const NDEF = (function() {
  function serialize(payload, mediaType) {
    const mediaTypeBytes = new TextEncoder().encode(mediaType);

    const typeLength = mediaTypeBytes.length;
    const payloadLength = payload.length;

    const isShortRecord = payloadLength < 256;
    const header = isShortRecord ? 0xD2 : 0xC2;

    const headerSize = 2 + (isShortRecord ? 1 : 4);
    const ndefRecordLength = headerSize + typeLength + payloadLength;
    const ndefRecord = new Uint8Array(ndefRecordLength);

    let offset = 0;
    ndefRecord[offset++] = header;
    ndefRecord[offset++] = typeLength;

    if (isShortRecord) {
      ndefRecord[offset++] = payloadLength;
    } else {
      ndefRecord[offset++] = (payloadLength >> 24) & 0xFF;
      ndefRecord[offset++] = (payloadLength >> 16) & 0xFF;
      ndefRecord[offset++] = (payloadLength >> 8) & 0xFF;
      ndefRecord[offset++] = payloadLength & 0xFF;
    }

    ndefRecord.set(mediaTypeBytes, offset);
    offset += typeLength;

    ndefRecord.set(payload, offset);

    const cc = new Uint8Array([
      0xE1, // NDEF Magic Number
      0x10, // Version 1.0
      0x00, // Size (calculated below)
      0x00  // Read/Write access
    ]);

    const ndefMessageLength = ndefRecordLength;
    const tlvLength = 2 + (ndefMessageLength < 255 ? 1 : 3) + ndefMessageLength + 1;
    const totalSize = Math.ceil((4 + tlvLength) / 8);
    cc[2] = totalSize;

    const tlvData = [];
    tlvData.push(0x03);

    if (ndefMessageLength < 255) {
      tlvData.push(ndefMessageLength);
    } else {
      tlvData.push(0xFF);
      tlvData.push((ndefMessageLength >> 8) & 0xFF);
      tlvData.push(ndefMessageLength & 0xFF);
    }

    tlvData.push(...ndefRecord);

    tlvData.push(0xFE);

    const result = new Uint8Array(4 + tlvData.length);
    result.set(cc, 0);
    result.set(tlvData, 4);

    return result;
  }

  function deserialize(buffer, mediaType) {
    try {
      const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;

      if (bytes.length < 7) {
        return null;
      }

      let offset = 0;

      if (bytes[0] !== 0xE1) {
        let found = false;
        for (let i = 0; i < Math.min(16, bytes.length - 4); i++) {
          if (bytes[i] === 0xE1) {
            offset = i;
            found = true;
            break;
          }
        }
        if (!found) {
          return null;
        }
      }

      if (bytes[offset] !== 0xE1) {
        return null;
      }
      offset += 4;

      while (offset < bytes.length - 1) {
        const tag = bytes[offset++];

        if (tag === 0xFE) {
          return null;
        }

        let tlvLength = bytes[offset++];

        if (tlvLength === 0xFF) {
          if (offset + 2 > bytes.length) {
            return null;
          }
          tlvLength = (bytes[offset] << 8) | bytes[offset + 1];
          offset += 2;
        }

        if (tag === 0x03) {
          const ndefData = bytes.slice(offset, offset + tlvLength);

          let ndefOffset = 0;

          while (ndefOffset < ndefData.length - 2) {
            const header = ndefData[ndefOffset++];
            const tnf = header & 0x07;
            const sr = (header >> 4) & 0x01;
            const il = (header >> 3) & 0x01;

            const typeLength = ndefData[ndefOffset++];

            let payloadLength;
            if (sr === 1) {
              payloadLength = ndefData[ndefOffset++];
            } else {
              if (ndefOffset + 4 > ndefData.length) {
                break;
              }
              payloadLength = (ndefData[ndefOffset] << 24) |
                (ndefData[ndefOffset + 1] << 16) |
                (ndefData[ndefOffset + 2] << 8) |
                ndefData[ndefOffset + 3];
              ndefOffset += 4;
            }

            let idLength = 0;
            if (il === 1) {
              idLength = ndefData[ndefOffset++];
            }

            const typeBytes = ndefData.slice(ndefOffset, ndefOffset + typeLength);
            ndefOffset += typeLength;

            if (idLength > 0) {
              ndefOffset += idLength;
            }

            if (tnf === 0x02) {
              const recordMediaType = new TextDecoder().decode(typeBytes);

              if (recordMediaType === mediaType) {
                const payload = ndefData.slice(ndefOffset, ndefOffset + payloadLength);
                return payload;
              }
            }

            ndefOffset += payloadLength;
          }

          return null;
        }

        offset += tlvLength;
      }

      return null;
    } catch (e) {
      console.error('Error deserializing NDEF:', e);
      return null;
    }
  }

  return {
    serialize,
    deserialize
  };
})();
