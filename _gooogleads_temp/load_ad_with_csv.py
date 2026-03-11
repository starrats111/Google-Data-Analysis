import csv
file_list = ['data/ad_group_mcc_2.csv', 'data/campaign_mcc_2.csv', 'data/keyword_mcc_1.csv', 'data/responsive_search_ad_1.csv']
# file_list = ['data/gg01.csv']
#cid campaignid campaign ad_group campaign_status campaign_type networks budget budget_type bid_strategy_type bid_strategy language location keyword type headline_1 headline_2 headline_3 description_1 descript_2 final_url
ad_dict = {}
counrty_dict = {}
with open('data/geotargets-2025-10-29.csv', encoding='utf-8', newline='') as csvfile:
    reader = csv.reader(csvfile)
    next(reader)
    for row in reader:
        counrty = row[2].split(',')[-1]
        code = row[4]
        counrty_dict[counrty] = code
# print(counrty_dict)


for file in file_list:
    with open(file, encoding='utf-8', newline='') as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            for key, value in row.items():
                ad_dict[key] = value
            break

# print(ad_dict)
