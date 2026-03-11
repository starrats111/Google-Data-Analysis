import argparse
import sys
import uuid
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException
from load_ad_with_csv import ad_dict
from model import gemini_model
from sem import SemRush
from add_ad_model import create


parser: argparse.ArgumentParser = argparse.ArgumentParser(
        description=("Creates a Responsive Search Ad for specified customer.")
    )
# The following argument(s) should be provided to run the example.
parser.add_argument(
    "-c",
    "--customer_id",
    type=str,
    required=True,
    help="The Google Ads customer ID.",
)

parser.add_argument(
    '-u',
    '--url',
    type=str,
    required=True,
    help="The URL to search.",
)

parser.add_argument(
    '-r',
    '--region',
    type=str,
    required=True,
    help="The region to search.",
)

parser.add_argument(
    '-a',
    '--attribute id',
    type=str
)

args: argparse.Namespace = parser.parse_args()
url = args.url
region = args.region
resource_name = args.customer_id

def get_ad_data_from_sem():
    sem = SemRush("yongpei", "lan181615", url.strip(), region.strip())
    sem.login()
    sem.set_node("10")
    sem.get_apikey()
    phrase_list = sem.organic()
    title_list, description_list = sem.adwords()

    goods_ad_data = {
        "keywords": phrase_list,
        "titles": title_list,
        "descriptions": description_list
    }
    return goods_ad_data


def create_ad(ad_dict_data):
    customizer_attribute_name = None
    if not resource_name:
        customizer_attribute_name = uuid.uuid4().hex

    # GoogleAdsClient will read the google-ads.yaml configuration file in the
    # home directory if none is specified.
    googleads_client: GoogleAdsClient = GoogleAdsClient.load_from_storage(
        version="v22",
        path="google-ads.yaml"
    )

    try:
        create(
            ad_dict_data,
            googleads_client,
            args.customer_id,
            resource_name,
            customizer_attribute_name,
        )
    except GoogleAdsException as ex:
        print(
            f'Request with ID "{ex.request_id}" failed with status '
            f'"{ex.error.code().name}" and includes the following errors:'
        )
        for error in ex.failure.errors:
            print(f'Error with message "{error.message}".')
            if error.location:
                for field_path_element in error.location.field_path_elements:
                    print(f"\t\tOn field: {field_path_element.field_name}")
        sys.exit(1)


if __name__ == '__main__':
    goods_ad_data = get_ad_data_from_sem()
    ad_data_temp = ad_dict.copy()
    gemini = gemini_model("AIzaSyAM9N2qMKs5McxpZQdadKKEsgWWFui_N_4")
    #print(ad_data_temp)
    keyword_len = max(len(goods_ad_data['keywords']), 5)
    title_len = max(len(goods_ad_data['titles']), 15)
    description_len = max(len(goods_ad_data['descriptions']), 15)
    #对接ai
    title_, descript_ = gemini.gemini_talk(url, 'us', goods_ad_data['keywords'], goods_ad_data['titles'], goods_ad_data['descriptions'])
    title_list = title_.split(',')
    description_list = descript_.split(',')
    count = 0
    for i in range(15):
        if len(title_list[i]) <= 30:
            count += 1
            ad_data_temp[f'Headline{i + 1}'] = title_list[i]
    ad_data_temp['Headline_count'] = count
    count = 0
    for i in range(4):
        if len(description_list[i]) <= 90:
            count += 1
            ad_data_temp[f'Description{i + 1}'] = description_list[i]
    ad_data_temp['Description_count'] = count
    #关键词
    for i in range(5):
        ad_data_temp[f'Keyword{i+1}'] = goods_ad_data['keywords'][i]

    create_ad(ad_data_temp)
