## Overview

Import data from OData feeds into your spreadsheet.

The plugin connects to [OData](https://www.odata.org/) services and allows you to browse available entity sets (tables), preview data, and insert it directly into cells as formatted tables.

OData Import is compatible with [self-hosted](https://github.com/Sarv/sarv-editors-plugins) and [desktop](https://github.com/Sarv/sarv-editors-plugins) versions of Sarv Office editors. It can be added to Sarv Office instances manually.

## How to use

1. Go to the Plugins tab and click on OData Import.

2. Enter an OData service URL (e.g., `https://services.odata.org/V4/Northwind/Northwind.svc`).

3. Click "Get Tables" to fetch available entity sets from the service.

4. Select a table from the list to preview its data.

5. Click "Insert" to paste the data into your spreadsheet starting from the current cell.

## How to install

Detailed instructions can be found in [Sarv Office API documentation](https://sarv.com).

## Supported OData versions

The plugin supports both OData v3 and OData v4 services.
