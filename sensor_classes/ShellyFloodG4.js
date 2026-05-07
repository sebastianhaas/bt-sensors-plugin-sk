const BTHomeServiceData = require("./BTHome/BTHomeServiceData");
const AbstractBTHomeSensor = require("./BTHome/AbstractBTHomeSensor");

/**
 * Sensor class representing the Shelly Flood Gen4 (model S4SN-0071A).
 *
 * This is a battery-powered Wi-Fi/Zigbee/BLE water-leak detector that also
 * broadcasts sensor data in the BTHome v2 format, making it compatible with
 * the BTHome framework.  It inherits from {@link AbstractBTHomeSensor}.
 *
 * Broadcast fields (BTHome object IDs):
 *   0x00  MISC_PACKET_ID       – rolling counter
 *   0x01  SENSOR_BATTERY       – battery level, 0-100 %
 *   0x20  BINARY_MOISTURE      – 0 = dry, 1 = water detected
 *   0xF0  DEVICE_TYPE          – model ID 0x1822
 *   0xF1  DEVICE_FW_VERSION_UINT32
 *
 * The device broadcasts on every flood-state change and as a periodic
 * heartbeat every 6 hours.
 *
 * NOTE: This device must be paired with the SignalK server machine so that
 * BlueZ keeps its device record alive between the infrequent advertisements.
 *
 * @see https://kb.shelly.cloud/knowledge-base/shelly-flood-gen4
 * @see https://bthome.io/format/
 */
class ShellyFloodG4 extends AbstractBTHomeSensor {
	static Domain = this.SensorDomains.environmental

	/**
	 * The local name prefix advertised by the Shelly Flood Gen4.
	 *
	 * Unlike Shelly BLU devices (e.g. "SBMO-003Z"), Gen4 devices broadcast as
	 * "ShellyFloodG4-XXXXXXXXXXXX" where XXXXXXXXXXXX is the full 12-character
	 * MAC address without colons.  The base name is used as a prefix in the
	 * overridden {@link identify} method.
	 *
	 * @type {string}
	 */
	static SHORTENED_LOCAL_NAME = "ShellyFloodG4";

	/**
	 * Alternate local name that may appear in paired/provisioned state.
	 * @type {string}
	 */
	static LOCAL_NAME = "Shelly Flood Gen4";

	static ImageFile = "ShellyFloodG4.webp";

	// ── Identification ──────────────────────────────────────────────────────

	/**
	 * Identifies a device as a Shelly Flood Gen4.
	 *
	 * Overrides the default implementation in {@link AbstractBTHomeSensor}
	 * because Gen4 devices use a full-MAC naming scheme
	 * ("ShellyFloodG4-AABBCCDDEEFF") rather than the 4-character suffix
	 * convention used by BLU devices and matched by
	 * {@link AbstractBTHomeSensor#hasNameAndAddress}.
	 *
	 * @param device The Bluetooth device to be identified.
	 * @returns {Promise<ShellyFloodG4|null>}
	 */
	static async identify(device) {
		if (!(await this.hasBtHomeServiceData(device))) return null;

		const name = await this.getDeviceProp(device, "Name");
		if (!name) return null;

		// "ShellyFloodG4-AABBCCDDEEFF" (provisioning / operating mode)
		if (name.startsWith(this.SHORTENED_LOCAL_NAME + "-")) return this;

		// Exact match for any alternate name used in paired state
		if (name === this.LOCAL_NAME) return this;

		return null;
	}

	// ── Description ─────────────────────────────────────────────────────────

	getTextDescription() {
		const pairedNote = this.isPaired()
			? "Device is paired."
			: 'NOTE: Device must be paired with SignalK server machine to operate properly'
			  + ' (see: <a href="https://shelly-api-docs.shelly.cloud/docs-ble/common#pairing"'
			  + ' target="_blank">https://shelly-api-docs.shelly.cloud/docs-ble/common#pairing</a>).';

		return `${pairedNote}<br><br>`
			+ 'For more information about the sensor click here: '
			+ '<a href="https://shelly.com/products/shelly-flood-gen4" target="_blank">'
			+ 'Shelly Flood Gen4</a>.';
	}

	

	// ── Schema ───────────────────────────────────────────────────────────────

	initSchema() {
		super.initSchema();
		this.addDefaultParam("zone", true);

		// ── Flood / moisture state ──────────────────────────────────────────
		// BINARY_MOISTURE (0x20): boolean, true = water detected.
		this.addMetadatum(
			"moisture",
			"boolean",
			"water detected",
			this.parseMoisture.bind(this),
		).default = "environment.{zone}.flooding";

        this.addMetadatum(
            "moisturePCT",
            "ratio",
            "moisture level",
            this.parseMoisturePercentage.bind(this),
        ).default = "environment.{zone}.moisturePCT";
 

		// ── Battery state-of-charge ─────────────────────────────────────────
		// SENSOR_BATTERY (0x01): 0-100 % integer → 0-1 ratio via parseBatteryLevel().
		this.addDefaultPath(
			"battery",
			"sensors.batteryStrength",
		).read = this.parseBatteryLevel.bind(this);

		this._schema.properties.params.properties.noContactThreshold.default = 0;
	}
}

module.exports = ShellyFloodG4;