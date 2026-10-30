/**
 * How many data sources (folders and repos) one agent may hold. A template
 * (dataNeeds) and a full copy (agent.dataSources) carry at most this many, so
 * adding one is held to it too: a 33rd source was accepted and made the
 * agent's own export one that could not be read back (audit #070).
 *
 * A module of its own, importing nothing: template.ts and transfer.ts both
 * build their schemas from it when they load, and they import each other's
 * neighbours, so a constant in either was not there yet for the other.
 */
export const MAX_DATA_SOURCES = 32;

/**
 * The longest name a data source may have (its /data folder, its clone dir,
 * or a host-path mount's label): what a template's dataNeeds and a full
 * copy's dataSources read. A 129-character folder name was accepted and the
 * agent's own template could not be imported (HB-0320).
 */
export const MAX_MOUNT_NAME = 128;
